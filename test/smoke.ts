import 'dotenv/config';

import { Context } from '@fraqjs/fraq';
import { createSimpleLogHandler } from '@fraqjs/mock';
import AiPlugin from '@fraqjs/plugin-ai';
import KyselyPlugin from '@fraqjs/plugin-kysely';
import MessageStorePlugin from '@fraqjs/plugin-message-store';

import ChatsaltPlugin from '../src';

import { readFileSync } from 'node:fs';

const ctx = Context.fromUrl('http://localhost:30001', {
  logHandler: createSimpleLogHandler(),
});

if (!process.env.OAC_ENDPOINT) {
  throw new Error('请在 .env 文件中设置 OAC_ENDPOINT');
}
if (!process.env.OAC_APIKEY) {
  throw new Error('请在 .env 文件中设置 OAC_APIKEY');
}
if (!process.env.MODEL) {
  throw new Error('请在 .env 文件中设置 MODEL');
}

ctx.install(AiPlugin, {
  providers: {
    deepseek: {
      sdk: '@ai-sdk/openai-compatible',
      options: {
        apiKey: process.env.OAC_APIKEY,
        baseURL: process.env.OAC_ENDPOINT,
      },
      models: [process.env.MODEL],
    },
  },
});
ctx.install(KyselyPlugin, {
  sqliteUrl: 'file:./fraq.db',
});
ctx.install(MessageStorePlugin);

ctx.install(ChatsaltPlugin, {
  persona: readFileSync('test/salt.persona.md', 'utf-8'),
  maxForwardDepth: 2,
  debug: {
    respondRejectedMessages: true,
    logAllToolCalls: true,
  },
});

ctx.start();

process.on('SIGINT', async () => {
  await ctx.stop();
  process.exit(0);
});
