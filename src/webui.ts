import type { WebuiGatewayService } from '@fraqjs/plugin-webui-gateway';

import type { ActivityRegistry } from './activity';
import type { MemoryStore } from './memory';

export interface ChatsaltWebuiOptions {
  memoryLimit: number;
}

export function mountChatsaltWebui(
  gateway: WebuiGatewayService,
  activity: ActivityRegistry,
  memoryStore: MemoryStore | undefined,
  options: ChatsaltWebuiOptions,
): void {
  gateway.mount({
    assets: new URL('../dist/webui', import.meta.url),
    routes(api) {
      api.get('/activity', (c) =>
        c.json({
          conversations: activity.listConversations(),
          warnings: activity.listWarnings(),
        }),
      );
      api.get('/memories', async (c) =>
        c.json({
          enabled: memoryStore !== undefined,
          memories: (await memoryStore?.list(options.memoryLimit)) ?? [],
        }),
      );
    },
  });
}
