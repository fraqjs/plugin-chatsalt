import { definePlugin, type milky, msg, seg, serviceToken } from '@fraqjs/fraq';
import { AiService, ai, createResourceIndex, xmlifyThread } from '@fraqjs/plugin-ai';
import { KyselyService } from '@fraqjs/plugin-kysely';
import type { WebuiGatewayService } from '@fraqjs/plugin-webui-gateway';

import pkg from '../package.json';
import { ActivityRegistry, summarizeMessage } from './activity';
import { MemoryStore } from './memory';
import { buildConversationContext, buildPrompt, buildSystemPrompt, extractSenderName } from './prompt';
import { describeImageTool, externalWebSearchTool, getMessageTool, memoryTools } from './tool';

export interface ChatsaltPluginOptions {
  persona: string;
  chatModel?: string;
  visionModel?: string;

  contextWindow?: number;
  maxForwardDepth?: number;
  temperature?: number;
  maxToolSteps?: number;
  extraPrompt?: string;
  trigger?: {
    keywords?: string[];
  };
  memory?: {
    enabled?: boolean;
    maxWindow?: number;
    maxScopeCount?: number;
  };
  externalWebSearch?: {
    enabled?: boolean;
    model?: string;
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

    const maxForwardDepth = options.maxForwardDepth ?? 0;
    const contextWindow = options.contextWindow ?? 20;
    const temperature = options.temperature ?? 0.8;
    const maxToolSteps = options.maxToolSteps ?? 10;

    const triggerKeywords = options.trigger?.keywords ?? [];

    const memoryEnabled = options.memory?.enabled ?? true;
    const maxMemoryWindow = options.memory?.maxWindow ?? 20;
    const maxMemoryScopeCount = options.memory?.maxScopeCount ?? 50;

    const externalWebSearchEnabled = options.externalWebSearch?.enabled ?? false;
    const externalWebSearchModel = ctx.ai.model(options.externalWebSearch?.model ?? options.chatModel);

    const debug_respondRejectedMessages = options.debug?.respondRejectedMessages ?? false;
    const debug_logAllToolCalls = options.debug?.logAllToolCalls ?? false;

    const systemPrompt: ai.SystemModelMessage = {
      role: 'system',
      content: buildSystemPrompt({
        persona: options.persona,
        memoryEnabled,
        externalWebSearchEnabled,
        extraPrompt: options.extraPrompt,
      }),
      providerOptions: {
        anthropic: {
          cacheControl: { type: 'ephemeral' },
        },
      },
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

      const senderName = extractSenderName(data);
      const recordContext = {
        selfId: self_id,
        scene: data.message_scene,
        peerId: data.peer_id,
        senderId: data.sender_id,
        senderName,
        messageSeq: data.message_seq,
      };

      try {
        if (data.message_scene === 'group') {
          // Send a reaction to indicate that the message is being processed
          await ctx.client.send_group_message_reaction({
            group_id: data.peer_id,
            message_seq: data.message_seq,
            reaction: '424',
          });
        }

        const resourceIndex = createResourceIndex();
        const { messages } = await ctx.client.get_history_messages({
          message_scene: data.message_scene,
          peer_id: data.peer_id,
          limit: contextWindow,
        });
        const thread = await xmlifyThread(ctx, messages, { maxForwardDepth, resourceIndex });
        const memoryScope = {
          selfId: self_id,
          scene: data.message_scene,
          peerId: data.peer_id,
        };

        const tools: Record<string, ai.Tool> = {};
        tools.describe_image = describeImageTool({ ctx, thread, visionModel });
        tools.get_message = getMessageTool({
          ctx,
          scene: data.message_scene,
          peerId: data.peer_id,
          thread,
          resourceIndex,
        });
        if (memoryStore) {
          Object.assign(tools, memoryTools(memoryStore, memoryScope));
        }
        if (externalWebSearchEnabled) {
          tools.external_web_search = externalWebSearchTool({ ctx, model: externalWebSearchModel });
        }

        const { text, toolResults, content } = await ai.generateText({
          model: chatModel,
          system: [
            systemPrompt,
            {
              role: 'system',
              content: buildConversationContext({
                selfId: self_id,
                scene: data.message_scene,
                senderId: data.sender_id,
                senderName,
              }),
            },
          ],
          prompt: buildPrompt({
            thread: thread.xmlContent,
            memories: await memoryStore?.recall(memoryScope),
          }),
          tools: tools,
          temperature: temperature,
          stopWhen: ai.stepCountIs(maxToolSteps),
        });

        for (const result of content) {
          if (result.type === 'tool-error') {
            ctx.logger.warn(`Tool call (${result.toolName}) failed`, result.error);
            activity.recordWarning({
              ...recordContext,
              kind: 'tool',
              message: `工具 ${result.toolName} 调用失败`,
              detail: stringifyError(result.error),
            });
          }
        }

        if (debug_logAllToolCalls) {
          if (toolResults.length > 0) {
            for (const result of toolResults) {
              ctx.logger.debug(
                `Tool call (${result.toolName}): ${JSON.stringify(result.input)} -> ${JSON.stringify(result.output)}`,
              );
            }
          }
        }

        if (!debug_respondRejectedMessages) {
          if (text.startsWith('no_reply')) {
            ctx.logger.warn(
              `Rejected message from ${data.sender_id} in ${data.message_scene} ${data.peer_id}: ${text}`,
            );
            activity.recordConversation({
              ...recordContext,
              input: summarizeMessage(data),
              output: text,
              outcome: 'rejected',
            });
            activity.recordWarning({
              ...recordContext,
              kind: 'rejected',
              message: '模型拒绝回复',
              detail: text,
            });
            if (data.message_scene === 'group') {
              // Send a reaction to indicate that the message was rejected
              await ctx.client.send_group_message_reaction({
                group_id: data.peer_id,
                message_seq: data.message_seq,
                reaction: '479',
              });
            }
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
        });
      } catch (error) {
        activity.recordWarning({
          ...recordContext,
          kind: 'generation',
          message: '对话处理失败',
          detail: stringifyError(error),
        });
        throw error;
      }
    });

    const chatsalt = ctx.router.group('chatsalt');

    chatsalt.command('inspect').execute(async (session) => {
      session.reply(msg`
===== Chatsalt 信息 =====
版本: ${pkg.version}
对话模型: ${stringifyModel(chatModel)}
视觉模型: ${stringifyModel(visionModel)}
      `);
    });
  },
});

export default ChatsaltPlugin;
