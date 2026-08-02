import { type Context, definePlugin } from '@fraqjs/fraq';
import { AiService, type ai } from '@fraqjs/plugin-ai';
import KyselyPlugin from '@fraqjs/plugin-kysely';
import { createMockContext } from '@fraqjs/plugin-mock';
import { WebuiGatewayService, type WebuiMountOptions } from '@fraqjs/plugin-webui-gateway';

import ChatsaltPlugin from '../src';

import assert from 'node:assert/strict';
import test from 'node:test';

const TestAiPlugin = definePlugin({
  name: 'test-ai',
  provides: [AiService],
  apply(ctx) {
    ctx.provide(
      AiService,
      new AiService({
        models: { mock: 'mock' as ai.LanguageModel },
        images: {},
        aliases: {},
        defaultModel: 'mock',
      }),
    );
  },
});

function installChatsalt(ctx: Context): void {
  ctx.install(TestAiPlugin);
  ctx.install(KyselyPlugin, { sqliteUrl: ':memory:', autoVacuum: { enabled: false } });
  ctx.install(ChatsaltPlugin, { persona: 'test persona' });
}

test('starts without the optional WebUI gateway', async () => {
  const ctx = createMockContext();
  installChatsalt(ctx);

  await ctx.start();
  await ctx.stop();
});

test('mounts the Chatsalt WebUI when the gateway service is available', async () => {
  let mounted: WebuiMountOptions | undefined;
  const TestGatewayPlugin = definePlugin({
    name: 'test-webui-gateway',
    provides: [WebuiGatewayService],
    apply(ctx) {
      ctx.provide(
        WebuiGatewayService,
        new WebuiGatewayService((options) => {
          mounted = options;
        }),
      );
    },
  });
  const ctx = createMockContext();
  ctx.install(TestGatewayPlugin);
  installChatsalt(ctx);

  await ctx.start();

  assert.ok(mounted);
  assert.match(String(mounted.assets), /dist\/webui$/);
  const routes: string[] = [];
  const api = {
    get(path: string) {
      routes.push(`GET ${path}`);
    },
    post() {},
    put() {},
    patch() {},
    delete() {},
  };
  mounted.routes?.(api);
  assert.deepEqual(routes, ['GET /activity', 'GET /memories']);

  await ctx.stop();
});
