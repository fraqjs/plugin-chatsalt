import { openai } from '@ai-sdk/openai';
import type { Context } from '@fraqjs/fraq';
import { ai, type ResourceIndex, type XmlifyContext, xmlify } from '@fraqjs/plugin-ai';
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
  visionModel: ai.LanguageModel;
}

export function describeImageTool({ ctx, thread, visionModel }: DescribeImageToolOptions): ai.Tool {
  return ai.tool({
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
        const { text } = await ai.generateText({
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
  thread: XmlifyContext;
  resourceIndex: ResourceIndex;
}

export function getMessageTool({ ctx, scene, peerId, thread, resourceIndex }: GetMessageToolOptions): ai.Tool {
  return ai.tool({
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
      const { xmlContent, resources, files, forwards } = await xmlify(ctx, message, {
        maxForwardDepth: 1,
        resourceIndex,
      });
      // merge fetched resources, files, and forwards into the current thread
      Object.assign(thread.resources, resources);
      Object.assign(thread.files, files);
      Object.assign(thread.forwards, forwards);
      return { ok: true, result: xmlContent };
    },
  });
}

export function memoryTools(store: MemoryStore, scope: MemoryScope): Record<'remember' | 'forget', ai.Tool> {
  return {
    remember: ai.tool({
      description: '记住一条有关当前会话对象的记忆',
      inputSchema: z.object({
        content: z.string().describe('记忆的内容'),
      }),
      execute: async (input) => {
        const entry = await store.remember(scope, input.content);
        return { ok: true, result: entry };
      },
    }),
    forget: ai.tool({
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

export interface ExternalWebSearchToolOptions {
  ctx: Context;
  model: ai.LanguageModel;
}

export function externalWebSearchTool({ ctx, model }: ExternalWebSearchToolOptions): ai.Tool {
  return ai.tool({
    description: '进行网页搜索',
    inputSchema: z.object({
      prompt: z.string().describe('搜索的提示词'),
    }),
    execute: async (input) => {
      try {
        const { text } = await ai.generateText({
          model,
          messages: [
            {
              role: 'user',
              content: [{ type: 'text', text: `请根据以下提示词进行网页搜索，并返回搜索结果的摘要：${input.prompt}` }],
            },
          ],
          tools: {
            web_search: openai.tools.webSearch(),
          },
        });
        return { ok: true, result: text };
      } catch (error) {
        ctx.logger.error(`网页搜索失败：${error}`);
        return { ok: false, error: `网页搜索失败: ${stringifyError(error)}` };
      }
    },
  });
}
