import { Readability } from '@mozilla/readability';
import ipaddr from 'ipaddr.js';
import { parseHTML } from 'linkedom';
import { Agent, buildConnector, fetch } from 'undici';

import pkg from '../package.json';

import { lookup } from 'node:dns/promises';
import type { ReadableStream } from 'node:stream/web';

const plainTextContentTypes = new Set(['text/csv', 'text/markdown', 'text/plain']);
const redirectStatuses = new Set([301, 302, 303, 307, 308]);

export interface WebPageOptions {
  timeoutMs: number;
  maxResponseBytes: number;
  maxContentLength: number;
  maxRedirects: number;
}

export interface WebPageContent {
  url: string;
  title: string;
  contentType: string;
  content: string;
}

type ContentKind = 'html' | 'json' | 'text' | 'xml';

function getContentKind(contentType: string): ContentKind | undefined {
  if (contentType === 'text/html' || contentType === 'application/xhtml+xml') {
    return 'html';
  }
  if (contentType === 'application/json' || (contentType.startsWith('application/') && contentType.endsWith('+json'))) {
    return 'json';
  }
  if (
    contentType === 'application/xml' ||
    contentType === 'text/xml' ||
    (contentType.startsWith('application/') && contentType.endsWith('+xml'))
  ) {
    return 'xml';
  }
  if (plainTextContentTypes.has(contentType)) {
    return 'text';
  }
  return undefined;
}

function assertPublicAddress(address: string): void {
  const parsed = ipaddr.process(address);
  if (parsed.range() !== 'unicast') {
    throw new Error(`不允许访问非公网地址：${address}`);
  }
}

function parseWebPageUrl(input: string): URL {
  const url = new URL(input);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('只允许访问 HTTP 或 HTTPS 网页');
  }
  if (url.username || url.password) {
    throw new Error('网页 URL 不能包含用户名或密码');
  }
  if (!url.hostname) {
    throw new Error('网页 URL 缺少域名');
  }
  return url;
}

async function resolvePublicAddress(url: URL): Promise<string> {
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (ipaddr.isValid(hostname)) {
    assertPublicAddress(hostname);
    return hostname;
  }

  const addresses = await lookup(hostname, { all: true, verbatim: true });
  if (addresses.length === 0) {
    throw new Error(`无法解析网页域名：${hostname}`);
  }
  for (const { address } of addresses) {
    assertPublicAddress(address);
  }
  return addresses[0].address;
}

async function readLimitedBody(body: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<Uint8Array> {
  if (!body) {
    return new Uint8Array();
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      size += value.byteLength;
      if (size > maxBytes) {
        throw new Error(`网页响应超过 ${maxBytes} 字节限制。`);
      }
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  }

  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function decodeBody(body: Uint8Array, contentType: string): string {
  const charset = /charset\s*=\s*["']?([^;\s"']+)/i.exec(contentType)?.[1] ?? 'utf-8';
  try {
    return new TextDecoder(charset).decode(body);
  } catch {
    return new TextDecoder().decode(body);
  }
}

export function extractWebPageContent(
  text: string,
  url: URL,
  contentType: string,
  maxContentLength: number,
): WebPageContent {
  const kind = getContentKind(contentType);
  if (!kind) {
    throw new Error(`不支持网页内容类型：${contentType || '未知'}`);
  }

  let title = url.hostname;
  let content: string;
  if (kind === 'html') {
    const { document } = parseHTML(text);
    const article = new Readability(document as unknown as ConstructorParameters<typeof Readability>[0], {
      maxElemsToParse: 100_000,
    }).parse();
    title = article?.title?.trim() || document.title.trim() || title;
    content = article?.textContent || document.body?.textContent || '';
  } else if (kind === 'json') {
    try {
      content = JSON.stringify(JSON.parse(text));
    } catch {
      throw new Error('网页返回的 JSON 内容无效');
    }
  } else {
    // XML remains plain text so DTDs and external entities are never evaluated.
    content = text;
  }

  content = content.replace(/\s+/g, ' ').trim().slice(0, maxContentLength);
  if (!content) {
    throw new Error('网页中没有可读取的文本内容。');
  }
  return { url: url.href, title, contentType, content };
}

export async function fetchWebPage(input: string, options: WebPageOptions): Promise<WebPageContent> {
  let url = parseWebPageUrl(input);
  for (let redirectCount = 0; redirectCount <= options.maxRedirects; redirectCount++) {
    const address = await resolvePublicAddress(url);
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    const connect = buildConnector({ timeout: options.timeoutMs });
    const dispatcher = new Agent({
      connections: 1,
      connect(connectOptions, callback) {
        connect(
          {
            ...connectOptions,
            hostname: address,
            servername: ipaddr.isValid(hostname) ? undefined : hostname,
          },
          callback,
        );
      },
    });

    try {
      const response = await fetch(url, {
        dispatcher,
        redirect: 'manual',
        signal: AbortSignal.timeout(options.timeoutMs),
        headers: {
          accept:
            'text/html,application/xhtml+xml,application/json,application/xml,text/xml,text/plain,text/markdown,text/csv;q=0.9',
          'user-agent': `fraq-plugin-chatsalt/${pkg.version}`,
        },
      });

      if (redirectStatuses.has(response.status)) {
        const location = response.headers.get('location');
        await response.body?.cancel();
        if (!location) {
          throw new Error(`网页返回 ${response.status}，但没有提供重定向地址。`);
        }
        if (redirectCount === options.maxRedirects) {
          throw new Error(`网页重定向次数超过 ${options.maxRedirects} 次限制。`);
        }
        url = parseWebPageUrl(new URL(location, url).href);
        continue;
      }

      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`网页请求失败：HTTP ${response.status}`);
      }

      const contentTypeHeader = response.headers.get('content-type') ?? 'text/html';
      const contentType = contentTypeHeader.split(';', 1)[0].trim().toLowerCase();
      if (!getContentKind(contentType)) {
        await response.body?.cancel();
        throw new Error(`不支持网页内容类型：${contentType || '未知'}`);
      }

      const contentLength = Number(response.headers.get('content-length'));
      if (Number.isFinite(contentLength) && contentLength > options.maxResponseBytes) {
        await response.body?.cancel();
        throw new Error(`网页响应超过 ${options.maxResponseBytes} 字节限制。`);
      }

      const body = await readLimitedBody(response.body, options.maxResponseBytes);
      const text = decodeBody(body, contentTypeHeader);
      return extractWebPageContent(text, url, contentType, options.maxContentLength);
    } finally {
      await dispatcher.close();
    }
  }

  throw new Error('网页抓取未能完成。');
}
