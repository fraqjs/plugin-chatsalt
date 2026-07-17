import type { Context } from '@fraqjs/fraq';
import type { XmlifyContext } from '@fraqjs/plugin-ai';
import { generateText, type LanguageModel, type Tool, tool } from 'ai';
import z from 'zod';

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
        const response = await fetch(imageInfo.url, { redirect: 'follow' });
        if (!response.ok) {
          options.ctx.logger.error(`下载图片失败：HTTP ${response.status}`);
          return { ok: false, error: `图片下载失败` };
        }
        const image = await response.arrayBuffer();
        const question = input.question || '请描述这张图片的内容。';
        const { text } = await generateText({
          model: options.visionModel,
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'text',
                  text: question,
                },
                {
                  type: 'file',
                  mediaType: 'image',
                  data: image,
                },
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
