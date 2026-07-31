import { definePlugin, type milky, msg, seg } from '@fraqjs/fraq';
import { AiService, ai, createResourceIndex, xmlifyThread } from '@fraqjs/plugin-ai';
import { KyselyService } from '@fraqjs/plugin-kysely';

import pkg from '../package.json';
import { MemoryStore } from './memory';
import { buildPrompt, buildSystemPrompt, extractSenderName } from './prompt';
import { describeImageTool, getMessageTool, memoryTools } from './tool';

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

export const ChatsaltPlugin = definePlugin({
  name: 'chatsalt',
  inject: {
    ai: AiService,
    kysely: KyselyService,
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

    const debug_respondRejectedMessages = options.debug?.respondRejectedMessages ?? false;
    const debug_logAllToolCalls = options.debug?.logAllToolCalls ?? false;

    let memoryStore: MemoryStore | undefined;
    if (memoryEnabled) {
      memoryStore = new MemoryStore(ctx.kysely, {
        maxWindow: maxMemoryWindow,
        maxScopeCount: maxMemoryScopeCount,
      });
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

      const { text, toolResults, content } = await ai.generateText({
        model: chatModel,
        system: buildSystemPrompt({
          selfId: self_id,
          scene: data.message_scene,
          senderId: data.sender_id,
          senderName: extractSenderName(data),
          persona: options.persona,
          memoryEnabled: memoryEnabled,
          extraPrompt: options.extraPrompt,
        }),
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
          ctx.logger.warn(`Rejected message from ${data.sender_id} in ${data.message_scene} ${data.peer_id}: ${text}`);
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
