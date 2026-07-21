import type { Context } from '@fraqjs/fraq';
import type { XmlifyContext } from '@fraqjs/plugin-ai';
import { generateText, type LanguageModel, type Tool, tool } from 'ai';
import z from 'zod';

import type { MemoryScope, MemoryStore } from './memory';

export interface DescribeImageToolOptions {
  ctx: Context;
  thread: XmlifyContext;
  visionModel: LanguageModel;
}

export function describeImageTool(options: DescribeImageToolOptions): Tool {
  return tool({
    description: '描述图片内容，或对图片内容提出特定的问题。',
    inputSchema: z.object({
      imageId: z.string().describe('图片的 id'),
      question: z.string().optional().describe('对图片提出的问题'),
    }),
    execute: async (input) => {
      const imageInfo = options.thread.resources[input.imageId];
      if (!imageInfo) {
        throw new Error(`找不到 id 为 ${input.imageId} 的图片资源。`);
      }

      try {
        const question = input.question || '请描述这张图片的内容。';
        const { text } = await generateText({
          model: options.visionModel,
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
        options.ctx.logger.error(`描述图片失败：${error}`);
        return { ok: false, error: `描述图片失败` };
      }
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
