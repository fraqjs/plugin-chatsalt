import type { Context } from '@fraqjs/fraq';
import { type ResourceIndex, type XmlifyContext, xmlify } from '@fraqjs/plugin-ai';
import { generateText, type LanguageModel, type Tool, tool } from 'ai';
import z from 'zod';

import type { MemoryScope, MemoryStore } from './memory';

function stringifyError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export interface DescribeImageToolOptions {
  ctx: Context;
  thread: XmlifyContext;
  visionModel: LanguageModel;
}

export function describeImageTool({ ctx, thread, visionModel }: DescribeImageToolOptions): Tool {
  return tool({
    description: '描述图片内容，或对图片内容提出特定的问题。',
    inputSchema: z.object({
      imageId: z.string().describe('图片的 id'),
      question: z.string().optional().describe('对图片提出的问题'),
    }),
    execute: async (input) => {
      const imageInfo = thread.resources[input.imageId];
      if (!imageInfo) {
        throw new Error(`找不到 id 为 ${input.imageId} 的图片资源。`);
      }

      try {
        const question = input.question || '请描述这张图片的内容。';
        const { text } = await generateText({
          model: visionModel,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: question },
                { type: 'file', mediaType: 'image', data: { type: 'url', url: new URL(imageInfo.url) } },
              ],
            },
          ],
        });
        return { ok: true, result: text };
      } catch (error) {
        ctx.logger.error(`描述图片失败：${error}`);
        return { ok: false, error: `描述图片失败: ${stringifyError(error)}` };
      }
    },
  });
}

export interface GetMessageToolOptions {
  ctx: Context;
  scene: 'friend' | 'group';
  peerId: number;
  resourceIndex: ResourceIndex;
}

export function getMessageTool({ ctx, scene, peerId, resourceIndex }: GetMessageToolOptions): Tool {
  return tool({
    description: '获取指定消息的内容，包括合并转发消息的具体内容',
    inputSchema: z.object({
      seq: z.number().describe('消息的 seq'),
    }),
    execute: async (input) => {
      const { message } = await ctx.client.get_message({
        message_scene: scene,
        peer_id: peerId,
        message_seq: input.seq,
      });
      const thread = await xmlify(ctx, message, { maxForwardDepth: 1, resourceIndex });
      return { ok: true, result: thread };
    },
  });
}

export function memoryTools(store: MemoryStore, scope: MemoryScope): Record<'remember' | 'forget', Tool> {
  return {
    remember: tool({
      description: '记住一条有关当前会话对象的记忆',
      inputSchema: z.object({
        content: z.string().describe('记忆的内容'),
      }),
      execute: async (input) => {
        const entry = await store.remember(scope, input.content);
        return { ok: true, result: entry };
      },
    }),
    forget: tool({
      description: '忘记一条有关当前会话对象的记忆',
      inputSchema: z.object({
        id: z.number().describe('记忆的 ID'),
      }),
      execute: async (input) => {
        const success = await store.forget(scope, input.id);
        return { ok: success };
      },
    }),
  };
}
