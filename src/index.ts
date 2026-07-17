import { definePlugin, msg } from '@fraqjs/fraq';
import { AiService, xmlifyThread } from '@fraqjs/plugin-ai';
import { KyselyService } from '@fraqjs/plugin-kysely';
import { generateText, stepCountIs } from 'ai';

import { buildPrompt, buildSystemPrompt, extractSenderName } from './prompt';
import { describeImageTool } from './tool';
import { shouldTriggerChat } from './trigger';

export interface ChatsaltPluginOptions {
  persona: string;
  contextSize?: number;
  temperature?: number;
  maxToolSteps?: number;
  chatModel?: string;
  visionModel?: string;
  extraPrompt?: string;
}

export const ChatsaltPlugin = definePlugin({
  name: 'chatsalt',
  inject: {
    ai: AiService,
    kysely: KyselyService,
  },
  apply(ctx, options: ChatsaltPluginOptions) {
    ctx.on('message_receive', async ({ self_id, data }) => {
      const contextSize = options.contextSize ?? 20;
      const temperature = options.temperature ?? 0.7;
      const maxToolSteps = options.maxToolSteps ?? 10;

      const visionModel = ctx.ai.model(options.visionModel ?? options.chatModel);

      if (!shouldTriggerChat(self_id, data)) {
        return;
      }

      const { messages } = await ctx.client.get_history_messages({
        message_scene: data.message_scene,
        peer_id: data.peer_id,
        limit: contextSize,
      });
      const thread = await xmlifyThread(ctx, messages);

      const { text } = await generateText({
        model: ctx.ai.model(options.chatModel),
        system: buildSystemPrompt({
          selfId: self_id,
          scene: data.message_scene as 'friend' | 'group',
          senderId: data.sender_id,
          senderName: extractSenderName(data),
          persona: options.persona,
        }),
        prompt: buildPrompt({
          thread: thread.xmlContent,
        }),
        tools: {
          describe_image: describeImageTool({ ctx, thread, visionModel }),
        },
        temperature: temperature,
        stopWhen: stepCountIs(maxToolSteps)
      });

      switch (data.message_scene) {
        case 'friend':
          await ctx.client.send_private_message({
            user_id: data.sender_id,
            message: msg`${text}`,
          });
          break;
        case 'group':
          await ctx.client.send_group_message({
            group_id: data.peer_id,
            message: msg`${text}`,
          });
          break;
      }
    });
  },
});

export default ChatsaltPlugin;
