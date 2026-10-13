import { type Context, definePlugin, type milky, msg, param, seg, serviceToken } from '@fraqjs/fraq';
import { AiService, ai, xmlify } from '@fraqjs/plugin-ai';
import { KyselyService } from '@fraqjs/plugin-kysely';
import type { WebuiGatewayService } from '@fraqjs/plugin-webui-gateway';
import { createGithubTools as githubTools } from '@github-tools/sdk';

import pkg from '../package.json';
import { ActivityRegistry, summarizeMessage } from './activity';
import { cacheBreakpoint, cacheLatestStepMessage } from './cache';
import { MemoryStore } from './memory';
import { buildPromptMessage, buildSystemPrompt, extractSenderName } from './prompt';
import {
  describeImageTool,
  externalWebSearchTool,
  getMessageTool,
  memoryTools,
  openWebPageTool,
  providerWebSearchToolForModel,
  type ThreadResources,
  viewImageTool,
} from './tool';

export interface ChatsaltPluginOptions {
  persona: string;
  chatModel?: string;
  visionModel?: string;

  owners?: number[];
  contextWindow?: number;
  contextStep?: number;
  maxForwardDepth?: number;
  temperature?: number;
  maxToolSteps?: number;
  disableBuiltinSecurityPrompt?: boolean;
  extraPrompt?: string;
  trigger?: {
    keywords?: string[];
  };
  memory?: {
    enabled?: boolean;
    maxWindow?: number;
    maxScopeCount?: number;
  };
  builtinWebSearch?: {
    enabled?: boolean;
  };
  externalWebSearch?: {
    enabled?: boolean;
    model?: string;
  };
  webPage?: {
    enabled?: boolean;
    timeoutMs?: number;
    maxResponseBytes?: number;
    maxContentLength?: number;
    maxRedirects?: number;
  };
  github?: {
    enabled?: boolean;
    token?: string;
  };
  webui?: {
    enabled?: boolean;
    conversationLimit?: number;
    warningLimit?: number;
    memoryLimit?: number;
  };

  debug?: {
    respondRejectedMessages?: boolean;
    logAllToolCalls?: boolean;
  };
}

function stringifyModel(model: ai.LanguageModel | ai.ImageModel) {
  if (typeof model === 'string') {
    return model;
  }
  return model.modelId;
}

function stringifyError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

const HISTORY_PAGE_LIMIT = 30; // upper bound of get_history_messages' `limit` in the Milky protocol

/**
 * Fetches the history ending at `message`, starting after a seq anchor that only advances every
 * `contextStep` messages. Between advances, consecutive requests share the same oldest message and
 * the thread only grows at its end, so its serialized prefix stays cacheable. The window spans
 * `contextWindow` to `contextWindow + contextStep - 1` seqs; seqs missing from storage (such as
 * recalled messages) shrink it without moving the anchor.
 */
async function fetchAnchoredHistory(
  ctx: Context,
  message: milky.IncomingFriendMessage | milky.IncomingGroupMessage,
  contextWindow: number,
  contextStep: number,
): Promise<milky.IncomingMessage[]> {
  const anchor = Math.floor((message.message_seq - contextWindow) / contextStep) * contextStep;
  const history: milky.IncomingMessage[] = [];
  let startSeq = message.message_seq;
  while (startSeq > anchor) {
    const { messages, next_message_seq } = await ctx.client.get_history_messages({
      message_scene: message.message_scene,
      peer_id: message.peer_id,
      start_message_seq: startSeq,
      limit: Math.min(HISTORY_PAGE_LIMIT, startSeq - anchor),
    });
    const oldestSeq = history[0]?.message_seq ?? Number.POSITIVE_INFINITY;
    history.unshift(...messages.filter((m) => m.message_seq > anchor && m.message_seq < oldestSeq));
    if (next_message_seq == null || next_message_seq >= startSeq) {
      break;
    }
    startSeq = next_message_seq;
  }
  return history;
}

export const ChatsaltPlugin = definePlugin({
  name: 'chatsalt',
  inject: {
    ai: AiService,
    kysely: KyselyService,
  },
  optionalInject: {
    webui: serviceToken<WebuiGatewayService>('fraqjs/webui-gateway/WebuiGatewayService'),
  },
  apply(ctx, options: ChatsaltPluginOptions) {
    const chatModel = ctx.ai.model(options.chatModel);
    const visionModel = ctx.ai.model(options.visionModel ?? options.chatModel);

    const owners = options.owners ?? [];
    const contextWindow = options.contextWindow ?? 20;
    const contextStep = options.contextStep ?? 10;
    if (!Number.isInteger(contextWindow) || contextWindow < 1) {
      throw new Error('contextWindow must be a positive integer.');
    }
    if (!Number.isInteger(contextStep) || contextStep < 1) {
      throw new Error('contextStep must be a positive integer.');
    }
    const maxForwardDepth = options.maxForwardDepth ?? 0;
    const temperature = options.temperature ?? 0.8;
    const maxToolSteps = options.maxToolSteps ?? 10;
    const disableBuiltinSecurityPrompt = options.disableBuiltinSecurityPrompt ?? false;

    const triggerKeywords = options.trigger?.keywords ?? [];

    const memoryEnabled = options.memory?.enabled ?? true;
    const maxMemoryWindow = options.memory?.maxWindow ?? 20;
    const maxMemoryScopeCount = options.memory?.maxScopeCount ?? 50;

    const builtinWebSearchEnabled = options.builtinWebSearch?.enabled ?? false;
    const externalWebSearchEnabled = options.externalWebSearch?.enabled ?? false;
    const externalWebSearchModel = ctx.ai.model(options.externalWebSearch?.model ?? options.chatModel);
    if (builtinWebSearchEnabled && externalWebSearchEnabled) {
      throw new Error('Cannot enable both builtinWebSearch and externalWebSearch at the same time.');
    }

    const webPageEnabled = options.webPage?.enabled ?? false;
    const webPageTimeoutMs = options.webPage?.timeoutMs ?? 10_000;
    const webPageMaxResponseBytes = options.webPage?.maxResponseBytes ?? 2 * 1024 * 1024;
    const webPageMaxContentLength = options.webPage?.maxContentLength ?? 20_000;
    const webPageMaxRedirects = options.webPage?.maxRedirects ?? 3;

    const githubEnabled = options.github?.enabled ?? false;
    if (githubEnabled && !options.github?.token) {
      throw new Error('GitHub token is required when GitHub integration is enabled.');
    }
    const githubToken = options.github?.token;

    const debug_respondRejectedMessages = options.debug?.respondRejectedMessages ?? false;
    const debug_logAllToolCalls = options.debug?.logAllToolCalls ?? false;

    const systemPrompt: ai.SystemModelMessage = {
      role: 'system',
      content: buildSystemPrompt({
        persona: options.persona,
        disableBuiltinSecurityPrompt,
        memoryEnabled,
        webSearchEnabled: builtinWebSearchEnabled || externalWebSearchEnabled,
        webPageEnabled,
        githubEnabled,
        extraPrompt: options.extraPrompt,
      }),
      providerOptions: cacheBreakpoint,
    };

    let memoryStore: MemoryStore | undefined;
    if (memoryEnabled) {
      memoryStore = new MemoryStore(ctx.kysely, {
        maxWindow: maxMemoryWindow,
        maxScopeCount: maxMemoryScopeCount,
      });
    }

    const activity = new ActivityRegistry({
      conversationLimit: options.webui?.conversationLimit ?? 100,
      warningLimit: options.webui?.warningLimit ?? 100,
    });
    const memoryRecordLimit = options.webui?.memoryLimit ?? 500;
    if (ctx.webui && (options.webui?.enabled ?? true)) {
      ctx.webui.mount({
        assets: new URL('../dist/webui', import.meta.url),
        routes(api) {
          api.get('/activity', (c) =>
            c.json({
              conversations: activity.listConversations(),
              warnings: activity.listWarnings(),
            }),
          );
          api.get('/memories', async (c) =>
            c.json({
              enabled: memoryStore !== undefined,
              memories: (await memoryStore?.list(memoryRecordLimit)) ?? [],
            }),
          );
        },
      });
      ctx.logger.info('Chatsalt WebUI registered at /webui/chatsalt/');
    }

    function shouldTriggerChat(selfId: number, message: milky.IncomingMessage): boolean {
      if (message.sender_id === selfId) {
        return false;
      }
      if (message.message_scene === 'temp') {
        return false;
      }
      if (message.message_scene === 'friend' && message.peer_id !== selfId) {
        return true;
      }
      // group
      if (message.message_scene === 'group') {
        const [first] = message.segments;
        if (!first) {
          return false;
        }
        if (first.type === 'reply' && first.data.sender_id === selfId) {
          return true;
        }
        if (message.segments.some((seg) => seg.type === 'mention' && seg.data.user_id === selfId)) {
          return true;
        }
      }
      // keyword trigger
      if (triggerKeywords.length > 0) {
        if (
          message.segments.some(
            (seg) => seg.type === 'text' && triggerKeywords.some((kw) => seg.data.text.includes(kw)),
          )
        ) {
          return true;
        }
      }
      return false;
    }

    ctx.on('message_receive', async ({ self_id, data }) => {
      if (!shouldTriggerChat(self_id, data)) {
        return;
      }
      if (data.message_scene === 'temp') {
        return;
      }

      const startedAt = performance.now();
      let toolCallCount = 0;
      let toolDurationMs = 0;
      const toolActivity = new Map<string, { callCount: number; durationMs: number }>();

      const reactedFaces = new Set<number>();
      const face_PressButton = 424; // processing
      const face_OpenEyes = 289; // calling vision
      const face_Learn = 481; // calling memory
      const face_Busy = 373; // calling web search, github, get message
      const face_Reject = 479; // rejected
      const face_Tremble = 41; // error

      async function reactFaceIfNotReacted(faceId: number) {
        if (data.message_scene === 'group' && !reactedFaces.has(faceId)) {
          try {
            await ctx.client.send_group_message_reaction({
              group_id: data.peer_id,
              message_seq: data.message_seq,
              reaction: String(faceId),
            });
          } catch (error) {
            ctx.logger.warn(
              `Failed to react with face ${faceId} to message ${data.message_seq} in group ${data.peer_id}`,
              error,
            );
          }
          reactedFaces.add(faceId);
        }
      }

      const senderName = extractSenderName(data);
      const recordContext = {
        selfId: self_id,
        scene: data.message_scene,
        peerId: data.peer_id,
        senderId: data.sender_id,
        senderName,
        messageSeq: data.message_seq,
      };
      const getActivityMetrics = () => ({
        durationMs: performance.now() - startedAt,
        toolCallCount,
        toolDurationMs,
        toolActivity: Array.from(toolActivity, ([name, metrics]) => ({ name, ...metrics })),
      });

      try {
        if (data.message_scene === 'group') {
          await ctx.client.send_group_message_reaction({
            group_id: data.peer_id,
            message_seq: data.message_seq,
            reaction: String(face_PressButton),
          }); // this react does not catch, to test message ability
        }
        const history = await fetchAnchoredHistory(ctx, data, contextWindow, contextStep);
        // The history normally ends with the triggering message; append it if storage has not caught up.
        const threadMessages = history.some((message) => message.message_seq === data.message_seq)
          ? history
          : [...history, data];
        const thread: ThreadResources = { resources: {}, files: {}, forwards: {} };
        const threadXml: string[] = [];
        for (const message of threadMessages) {
          const rendered = await xmlify(ctx, message, { maxForwardDepth, inThread: true });
          threadXml.push(rendered.xmlContent);
          Object.assign(thread.resources, rendered.resources);
          Object.assign(thread.files, rendered.files);
          Object.assign(thread.forwards, rendered.forwards);
        }
        const memoryScope = {
          selfId: self_id,
          scene: data.message_scene,
          peerId: data.peer_id,
        };

        const tools: Record<string, ai.Tool> = {};
        if (!options.visionModel || options.visionModel === options.chatModel) {
          tools.view_image = viewImageTool({ thread });
        } else {
          tools.describe_image = describeImageTool({ ctx, thread, visionModel });
        }
        tools.get_message = getMessageTool({
          ctx,
          scene: data.message_scene,
          peerId: data.peer_id,
          thread,
        });
        if (memoryStore) {
          Object.assign(tools, memoryTools(memoryStore, memoryScope));
        }
        if (builtinWebSearchEnabled) {
          if (typeof chatModel === 'string') {
            throw new Error('Assertion failed: chatModel must be an object when builtinWebSearch is enabled.');
          } else {
            tools.web_search = providerWebSearchToolForModel(chatModel);
          }
        }
        if (externalWebSearchEnabled) {
          tools.web_search = externalWebSearchTool({ ctx, model: externalWebSearchModel });
        }
        if (webPageEnabled) {
          tools.open_web_page = openWebPageTool({
            ctx,
            timeoutMs: webPageTimeoutMs,
            maxResponseBytes: webPageMaxResponseBytes,
            maxContentLength: webPageMaxContentLength,
            maxRedirects: webPageMaxRedirects,
          });
        }
        if (githubEnabled) {
          Object.assign(tools, githubTools({ token: githubToken, preset: 'repo-explorer' }));
        }

        const { text } = await ai.generateText({
          model: chatModel,
          instructions: systemPrompt,
          messages: [
            buildPromptMessage({
              selfId: self_id,
              scene: data.message_scene,
              peerId: data.peer_id,
              senderId: data.sender_id,
              senderName,
              messageSeq: data.message_seq,
              thread: threadXml,
              memories: await memoryStore?.recall(memoryScope),
            }),
          ],
          tools: tools,
          temperature: temperature,
          stopWhen: ai.stepCountIs(maxToolSteps),
          prepareStep: cacheLatestStepMessage,
          onToolExecutionStart: (e) => {
            if (debug_logAllToolCalls) {
              ctx.logger.debug(`Tool call (${e.toolCall.toolName}) <- ${JSON.stringify(e.toolCall.input)}`);
            }
            switch (e.toolCall.toolName) {
              case 'describe_image':
              case 'view_image':
                reactFaceIfNotReacted(face_OpenEyes);
                break;
              case 'remember':
              case 'forget':
                reactFaceIfNotReacted(face_Learn);
                break;
              default: // get_message, external_web_search, github tools
                reactFaceIfNotReacted(face_Busy);
                break;
            }
          },
          onToolExecutionEnd: (e) => {
            toolCallCount += 1;
            toolDurationMs += e.toolExecutionMs;
            const metrics = toolActivity.get(e.toolCall.toolName);
            if (metrics) {
              metrics.callCount += 1;
              metrics.durationMs += e.toolExecutionMs;
            } else {
              toolActivity.set(e.toolCall.toolName, {
                callCount: 1,
                durationMs: e.toolExecutionMs,
              });
            }
            if (e.toolOutput.type === 'tool-error') {
              ctx.logger.warn(`Tool call (${e.toolCall.toolName}) failed`, e.toolOutput.error);
              activity.recordWarning({
                ...recordContext,
                kind: 'tool',
                message: `工具 ${e.toolCall.toolName} 调用失败`,
                detail: stringifyError(e.toolOutput.error),
              });
            } else {
              // toolOutput.type === 'tool-success'
              if (debug_logAllToolCalls) {
                ctx.logger.debug(
                  `Tool call (${e.toolCall.toolName}) -> ${JSON.stringify(e.toolOutput.output)} (${e.toolExecutionMs}ms)`,
                );
              }
            }
          },
        });

        if (!debug_respondRejectedMessages) {
          if (text.trimStart().startsWith('no_reply')) {
            ctx.logger.warn(
              `Rejected message from ${data.sender_id} in ${data.message_scene} ${data.peer_id}: ${text}`,
            );
            activity.recordConversation({
              ...recordContext,
              input: summarizeMessage(data),
              output: text,
              outcome: 'rejected',
              ...getActivityMetrics(),
            });
            activity.recordWarning({
              ...recordContext,
              kind: 'rejected',
              message: '模型拒绝回复',
              detail: text,
            });
            reactFaceIfNotReacted(face_Reject);
            return;
          }
        }

        switch (data.message_scene) {
          case 'friend':
            await ctx.client.send_private_message({
              user_id: data.sender_id,
              message: msg`${seg.reply(data.message_seq)}${text}`,
            });
            break;
          case 'group':
            await ctx.client.send_group_message({
              group_id: data.peer_id,
              message: msg`${seg.reply(data.message_seq)}${text}`,
            });
            break;
        }
        activity.recordConversation({
          ...recordContext,
          input: summarizeMessage(data),
          output: text,
          outcome: 'replied',
          ...getActivityMetrics(),
        });
      } catch (error) {
        activity.recordWarning({
          ...recordContext,
          kind: 'generation',
          message: '对话处理失败',
          detail: stringifyError(error),
        });
        reactFaceIfNotReacted(face_Tremble);
        ctx.logger.error('对话处理失败', error);
      }
    });

    const chatsalt = ctx.router.group('chatsalt');

    chatsalt.command('inspect').execute(async (session) => {
      const information: string[] = [];
      information.push(`===== Chatsalt 信息 =====`);
      information.push(`版本: ${pkg.version}`);
      information.push(`对话模型: ${stringifyModel(chatModel)}`);
      if (options.visionModel && options.visionModel !== options.chatModel) {
        information.push(`视觉模型: ${stringifyModel(visionModel)}`);
      }
      if (externalWebSearchEnabled) {
        information.push(`网页搜索模型: ${stringifyModel(externalWebSearchModel)}`);
      }
      await session.reply(msg`${information.join('\n')}`);
    });

    chatsalt
      .filter((session) => session.raw.message_scene === 'group' && owners.includes(session.raw.sender_id))
      .command('rename')
      .arg('newName', param.greedy())
      .execute(async (session, { newName }) => {
        await ctx.client.set_group_member_card({
          group_id: session.raw.peer_id,
          user_id: session.selfId,
          card: newName,
        });
        await session.reply(msg`已将机器人昵称修改为 ${newName}`);
      });
  },
});

export default ChatsaltPlugin;
