import { definePlugin, msg, seg } from '@fraqjs/fraq';
import { AiService, createResourceIndex, xmlifyThread } from '@fraqjs/plugin-ai';
import { KyselyService } from '@fraqjs/plugin-kysely';
import { generateText, stepCountIs, type Tool } from 'ai';

import { MemoryStore } from './memory';
import { buildPrompt, buildSystemPrompt, extractSenderName } from './prompt';
import { describeImageTool, getMessageTool, memoryTools } from './tool';
import { shouldTriggerChat } from './trigger';

export interface ChatsaltPluginOptions {
  persona: string;
  chatModel?: string;
  visionModel?: string;

  contextWindow?: number;
  maxForwardDepth?: number;
  temperature?: number;
  maxToolSteps?: number;
  extraPrompt?: string;
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

    ctx.on('message_receive', async ({ self_id, data }) => {
      if (!shouldTriggerChat(self_id, data)) {
        return;
      }
      if (data.message_scene === 'temp') {
        return;
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

      const tools: Record<string, Tool> = {};
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

      const { text, toolResults, content } = await generateText({
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
        stopWhen: stepCountIs(maxToolSteps),
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
  },
});

export default ChatsaltPlugin;
