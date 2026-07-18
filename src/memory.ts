import type { KyselyService } from '@fraqjs/plugin-kysely';
import type { Generated } from 'kysely';

const MEMORY_TABLE = 'chatsalt_memory';

declare module '@fraqjs/plugin-kysely' {
  interface FraqDatabase {
    chatsalt_memory: {
      id: Generated<number>;
      self_id: number;
      scene: 'friend' | 'group';
      peer_id: number;
      subject_id: number;
      content: string;
      created_at: number;
      updated_at: number;
    };
  }
}

export interface MemoryStoreOptions {
  maxWindow: number;
  maxScopeCount: number;
}

export interface MemoryScope {
  selfId: number;
  scene: 'friend' | 'group';
  peerId: number;
  subjectId: number;
}

export interface MemoryEntry {
  id: number;
  selfId: number;
  scene: 'friend' | 'group';
  peerId: number;
  subjectId: number;
  content: string;
  createdAt: number;
  updatedAt: number;
}

export class MemoryStore {
  constructor(
    private kysely: KyselyService,
    private options: MemoryStoreOptions,
  ) {
    kysely.schemas.register({
      name: 'chatsalt_memory',
      migrations: {
        '001_create_memory_table': {
          async up(db) {
            await db.schema
              .createTable(MEMORY_TABLE)
              .addColumn('id', 'integer', (column) => column.primaryKey().autoIncrement())
              .addColumn('self_id', 'integer', (column) => column.notNull())
              .addColumn('scene', 'text', (column) => column.notNull())
              .addColumn('peer_id', 'integer', (column) => column.notNull())
              .addColumn('subject_id', 'integer', (column) => column.notNull())
              .addColumn('content', 'text', (column) => column.notNull())
              .addColumn('created_at', 'integer', (column) => column.notNull())
              .addColumn('updated_at', 'integer', (column) => column.notNull())
              .execute();

            await db.schema
              .createIndex('chatsalt_memory_scope_idx')
              .on(MEMORY_TABLE)
              .columns(['self_id', 'scene', 'peer_id', 'subject_id', 'created_at'])
              .execute();
          },
        },
      },
    });
  }

  async recall(scope: MemoryScope): Promise<MemoryEntry[]> {
    const rows = await this.scopeQuery(scope)
      .selectAll()
      .orderBy('created_at', 'desc')
      .limit(this.options.maxWindow)
      .execute();

    return rows.map(mapRow).toReversed();
  }

  async remember(scope: MemoryScope, content: string): Promise<MemoryEntry> {
    const now = Date.now();
    const trimmed = content.trim();
    if (!trimmed) {
      throw new Error('memory content must not be empty');
    }

    const result = await this.kysely.db
      .insertInto(MEMORY_TABLE)
      .values({
        self_id: scope.selfId,
        scene: scope.scene,
        peer_id: scope.peerId,
        subject_id: scope.subjectId,
        content: trimmed,
        created_at: now,
        updated_at: now,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    await this.prune(scope);
    return mapRow(result);
  }

  async forget(scope: MemoryScope, id: number): Promise<boolean> {
    const result = await this.kysely.db
      .deleteFrom(MEMORY_TABLE)
      .where('id', '=', id)
      .where('self_id', '=', scope.selfId)
      .where('scene', '=', scope.scene)
      .where('peer_id', '=', scope.peerId)
      .where('subject_id', '=', scope.subjectId)
      .executeTakeFirst();

    return Number(result.numDeletedRows) > 0;
  }

  private async prune(scope: MemoryScope): Promise<void> {
    const maxScopeCount = this.options.maxScopeCount;
    if (maxScopeCount <= 0) {
      return;
    }

    const overflow = await this.scopeQuery(scope)
      .select('id')
      .orderBy('created_at', 'desc')
      .offset(maxScopeCount)
      .execute();

    if (overflow.length === 0) {
      return;
    }

    await this.kysely.db
      .deleteFrom(MEMORY_TABLE)
      .where(
        'id',
        'in',
        overflow.map((row) => row.id),
      )
      .execute();
  }

  private scopeQuery(scope: MemoryScope) {
    return this.kysely.db
      .selectFrom(MEMORY_TABLE)
      .where('self_id', '=', scope.selfId)
      .where('scene', '=', scope.scene)
      .where('peer_id', '=', scope.peerId)
      .where('subject_id', '=', scope.subjectId);
  }
}

function mapRow(row: {
  id: number;
  self_id: number;
  scene: 'friend' | 'group';
  peer_id: number;
  subject_id: number;
  content: string;
  created_at: number;
  updated_at: number;
}): MemoryEntry {
  return {
    id: row.id,
    selfId: row.self_id,
    scene: row.scene,
    peerId: row.peer_id,
    subjectId: row.subject_id,
    content: row.content,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
