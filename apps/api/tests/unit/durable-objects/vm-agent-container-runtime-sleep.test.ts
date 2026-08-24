import { describe, expect, it, vi } from 'vitest';

import { persistRuntimeSleepingAfterRevokedWake } from '../../../src/durable-objects/vm-agent-container-runtime';

describe('revoked container wake sleeping compensation', () => {
  it('updates only the exact live node/workspace ownership and excludes terminal rows', async () => {
    const statements: Array<{ sql: string; bindings: unknown[] }> = [];
    const database = {
      prepare: vi.fn((sql: string) => {
        const statement = { sql, bindings: [] as unknown[] };
        statements.push(statement);
        return {
          bind: (...bindings: unknown[]) => {
            statement.bindings = bindings;
            return statement;
          },
        };
      }),
      batch: vi.fn(async () => []),
    };

    await persistRuntimeSleepingAfterRevokedWake({ DATABASE: database } as never, {
      nodeId: 'node-1',
      workspaceId: 'workspace-1',
    });

    expect(database.batch).toHaveBeenCalledOnce();
    expect(statements).toHaveLength(3);
    for (const statement of statements) {
      expect(statement.sql).toContain("status NOT IN ('stopped', 'deleted', 'error')");
      expect(statement.bindings).toContain('node-1');
      expect(statement.bindings).toContain('workspace-1');
    }
    expect(statements[1]?.sql).toContain('node_id = ?');
    expect(statements[2]?.sql).toContain('WHERE workspace_id = ?');
  });
});
