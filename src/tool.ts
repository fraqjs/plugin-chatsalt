import { openai } from '@ai-sdk/openai';
import type { Context } from '@fraqjs/fraq';
import { ai, type ResourceIndex, type XmlifyContext, xmlify } from '@fraqjs/plugin-ai';
import z from 'zod';

import type { MemoryScope, MemoryStore } from './memory';
import { fetchWebPage, type WebPageOptions } from './web-page';

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
    description: '通过外部大模型进行网页搜索',
    inputSchema: z.object({
      keywords: z.array(z.string()).describe('搜索关键词'),
    }),
    execute: async (input) => {
      try {
        const { text } = await ai.generateText({
          model,
          prompt: `
请使用内置工具对如下关键词进行网页搜索并且给出摘要：
${input.keywords.join(', ')}

最多执行两次网页工具调用：先搜索，再按需打开一个最权威的官方页面，不要打开第二个页面。
返回不超过 300 字的摘要。
          `.trim(),
          tools: {
            web_search: openai.tools.webSearch({
              searchContextSize: 'low',
            }),
          },
          reasoning: 'none',
          maxOutputTokens: 512,
          maxRetries: 1,
        });
        return { ok: true, result: text };
      } catch (error) {
        ctx.logger.error(`网页搜索失败：${error}`);
        return { ok: false, error: `网页搜索失败: ${stringifyError(error)}` };
      }
    },
  });
}

export interface OpenWebPageToolOptions extends WebPageOptions {
  ctx: Context;
}

export function openWebPageTool({ ctx, ...options }: OpenWebPageToolOptions): ai.Tool {
  return ai.tool({
    description: '打开指定的 HTTP 或 HTTPS URL，并读取 HTML、JSON、XML、Markdown、CSV 或纯文本内容',
    inputSchema: z.object({
      url: z.url().describe('要打开的网页 URL'),
    }),
    execute: async ({ url }) => {
      try {
        return { ok: true, result: await fetchWebPage(url, options) };
      } catch (error) {
        ctx.logger.error(`打开网页失败：${error}`);
        return { ok: false, error: `打开网页失败：${stringifyError(error)}` };
      }
    },
  });
}
