import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

const migrationSql = readFileSync(
  join(process.cwd(), 'src/db/migrations/0131_task_supersession_marker.sql'),
  'utf8'
);

function createMigrationDb(): Database.Database {
  const sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      chat_session_id TEXT,
      recovery_source_task_id TEXT,
      status TEXT NOT NULL,
      triggered_by TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  return sqlite;
}

function timestamp(minutes: number): string {
  return new Date(Date.parse('2026-08-30T00:00:00.000Z') + minutes * 60_000).toISOString();
}

function seedTask(
  sqlite: Database.Database,
  input: {
    id: string;
    projectId?: string;
    chatSessionId?: string | null;
    recoverySourceTaskId?: string | null;
    status?: string;
    triggeredBy?: string;
    createdAtMinute?: number;
  }
): void {
  sqlite
    .prepare(
      `INSERT INTO tasks
         (id, project_id, chat_session_id, recovery_source_task_id, status,
          triggered_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.id,
      input.projectId ?? 'project-1',
      input.chatSessionId ?? null,
      input.recoverySourceTaskId ?? null,
      input.status ?? 'in_progress',
      input.triggeredBy ?? 'mcp',
      timestamp(input.createdAtMinute ?? 0)
    );
}

function supersessionMap(sqlite: Database.Database): Record<string, string | null> {
  const rows = sqlite
    .prepare(`SELECT id, superseded_by_task_id FROM tasks ORDER BY id ASC`)
    .all() as Array<{ id: string; superseded_by_task_id: string | null }>;
  return Object.fromEntries(rows.map((row) => [row.id, row.superseded_by_task_id]));
}

describe('0131_task_supersession_marker migration', () => {
  it('adds the supersession marker column and index', () => {
    const sqlite = createMigrationDb();
    try {
      sqlite.exec(migrationSql);

      const columns = sqlite.prepare(`PRAGMA table_info('tasks')`).all() as Array<{
        name: string;
      }>;
      const indexes = sqlite.prepare(`PRAGMA index_list('tasks')`).all() as Array<{
        name: string;
      }>;

      expect(columns.map((column) => column.name)).toContain('superseded_by_task_id');
      expect(indexes.map((index) => index.name)).toContain('idx_tasks_superseded_by_task_id');
    } finally {
      sqlite.close();
    }
  });

  it('backfills direct 29-link recovery chains to the earliest later successor', () => {
    const sqlite = createMigrationDb();
    try {
      seedTask(sqlite, { id: 'chain-root', createdAtMinute: 0 });
      let previous = 'chain-root';
      for (let index = 1; index <= 29; index += 1) {
        const id = `chain-${String(index).padStart(2, '0')}`;
        seedTask(sqlite, {
          id,
          recoverySourceTaskId: previous,
          triggeredBy: 'session-recovery',
          chatSessionId: index === 29 ? 'chat-chain' : null,
          createdAtMinute: index,
        });
        previous = id;
      }

      sqlite.exec(migrationSql);
      const markers = supersessionMap(sqlite);

      expect(markers['chain-root']).toBe('chain-01');
      for (let index = 1; index <= 28; index += 1) {
        expect(markers[`chain-${String(index).padStart(2, '0')}`]).toBe(
          `chain-${String(index + 1).padStart(2, '0')}`
        );
      }
      expect(markers['chain-29']).toBeNull();
    } finally {
      sqlite.close();
    }
  });

  it('backfills root-collapsed sibling families without using older owners', () => {
    const sqlite = createMigrationDb();
    try {
      seedTask(sqlite, { id: 'root-collapse', createdAtMinute: 0 });
      seedTask(sqlite, {
        id: 'root-collapse-wake-1',
        recoverySourceTaskId: 'root-collapse',
        triggeredBy: 'session-recovery',
        createdAtMinute: 1,
      });
      seedTask(sqlite, {
        id: 'root-collapse-wake-2',
        recoverySourceTaskId: 'root-collapse',
        triggeredBy: 'session-recovery',
        createdAtMinute: 2,
      });
      seedTask(sqlite, {
        id: 'root-collapse-wake-3',
        recoverySourceTaskId: 'root-collapse',
        triggeredBy: 'session-recovery',
        chatSessionId: 'chat-root-collapse',
        createdAtMinute: 3,
      });
      seedTask(sqlite, {
        id: 'direction-later-predecessor',
        recoverySourceTaskId: 'direction-root',
        createdAtMinute: 10,
      });
      seedTask(sqlite, {
        id: 'direction-older-owner',
        recoverySourceTaskId: 'direction-root',
        triggeredBy: 'session-recovery',
        chatSessionId: 'chat-direction',
        createdAtMinute: 9,
      });

      sqlite.exec(migrationSql);
      const markers = supersessionMap(sqlite);

      expect(markers['root-collapse']).toBe('root-collapse-wake-1');
      expect(markers['root-collapse-wake-1']).toBe('root-collapse-wake-2');
      expect(markers['root-collapse-wake-2']).toBe('root-collapse-wake-3');
      expect(markers['root-collapse-wake-3']).toBeNull();
      expect(markers['direction-later-predecessor']).toBeNull();
    } finally {
      sqlite.close();
    }
  });

  it('does not backfill terminal rows, current chat owners, or cross-project owners', () => {
    const sqlite = createMigrationDb();
    try {
      seedTask(sqlite, { id: 'terminal-predecessor', status: 'completed', createdAtMinute: 1 });
      seedTask(sqlite, {
        id: 'terminal-successor',
        recoverySourceTaskId: 'terminal-predecessor',
        triggeredBy: 'session-recovery',
        chatSessionId: 'chat-terminal',
        createdAtMinute: 2,
      });
      seedTask(sqlite, {
        id: 'chat-bound-predecessor',
        chatSessionId: 'chat-bound',
        createdAtMinute: 3,
      });
      seedTask(sqlite, {
        id: 'chat-bound-successor',
        recoverySourceTaskId: 'chat-bound-predecessor',
        triggeredBy: 'session-recovery',
        chatSessionId: 'chat-bound-successor',
        createdAtMinute: 4,
      });
      seedTask(sqlite, {
        id: 'cross-project-predecessor',
        projectId: 'project-1',
        createdAtMinute: 5,
      });
      seedTask(sqlite, {
        id: 'cross-project-successor',
        projectId: 'project-2',
        recoverySourceTaskId: 'cross-project-predecessor',
        triggeredBy: 'session-recovery',
        chatSessionId: 'chat-cross-project',
        createdAtMinute: 6,
      });

      sqlite.exec(migrationSql);
      const markers = supersessionMap(sqlite);

      expect(markers['terminal-predecessor']).toBeNull();
      expect(markers['chat-bound-predecessor']).toBeNull();
      expect(markers['cross-project-predecessor']).toBeNull();
    } finally {
      sqlite.close();
    }
  });
});
