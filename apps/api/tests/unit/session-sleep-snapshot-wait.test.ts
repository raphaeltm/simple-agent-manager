import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { describe, expect, it, vi } from 'vitest';

import * as schema from '../../src/db/schema';
import type { Env } from '../../src/env';
import { waitForFinalSessionSnapshot } from '../../src/services/session-sleep-snapshot-wait';
import { createSchemaTables, createSqliteD1 } from '../helpers/sqlite-d1';

const mocks = vi.hoisted(() => ({
  hibernateAgentSessionOnNode: vi.fn(),
}));

vi.mock('../../src/services/node-agent', () => ({
  hibernateAgentSessionOnNode: mocks.hibernateAgentSessionOnNode,
}));

describe('waitForFinalSessionSnapshot', () => {
  it('degrades with the recorded VM capture failure instead of the generic idle reason', async () => {
    const sqlite = new Database(':memory:');
    try {
      createSchemaTables(sqlite, [schema.sessionSnapshots]);
      sqlite
        .prepare(
          `INSERT INTO session_snapshots
             (id, workspace_id, user_id, chat_session_id, agent_session_id, runtime, status,
              degradation, manifest_r2_key, snapshot_generation, capture_generation, capture_error,
              expires_at, updated_at)
           VALUES ('snapshot-1', 'workspace-1', 'user-1', 'chat-1', 'agent-1', 'vm',
              'available', 'none', 'snapshots/chat-1/previous/manifest.json', 'previous',
              'capture-1', 'snapshot control plane returned HTTP 400: checksum mismatch',
              '2026-08-20T00:00:00.000Z', '2026-08-15T00:00:00.000Z')`
        )
        .run();
      const r2 = { put: vi.fn(), delete: vi.fn(async () => undefined) };
      const testEnv = {
        DATABASE: createSqliteD1(sqlite),
        R2: r2,
        SESSION_SNAPSHOT_R2_PREFIX: 'snapshots',
        SESSION_SNAPSHOT_REQUEST_TIMEOUT_MS: '1000',
        SESSION_SNAPSHOT_PROGRESS_IDLE_TIMEOUT_MS: '1000',
        SESSION_SNAPSHOT_POLL_INTERVAL_MS: '1',
      } as unknown as Env;
      const db = drizzle(testEnv.DATABASE, { schema });
      mocks.hibernateAgentSessionOnNode.mockResolvedValueOnce({ status: 'pending', accepted: true });

      await waitForFinalSessionSnapshot(db, testEnv, {
        nodeId: 'node-1',
        workspaceId: 'workspace-1',
        agentSessionId: 'agent-1',
        chatSessionId: 'chat-1',
        runtime: 'vm',
        agentType: 'openai-codex',
        acpSessionId: 'stale-acp-id',
        userId: 'user-1',
      });

      expect(r2.put).toHaveBeenCalledWith(
        'snapshots/chat-1/capture-1/manifest.json',
        expect.stringContaining('checksum mismatch'),
        expect.objectContaining({ httpMetadata: { contentType: 'application/json' } })
      );
      const manifest = JSON.parse(String(r2.put.mock.calls[0][1]));
      expect(manifest.skipped).toEqual([
        {
          path: 'workspace-snapshot',
          reason: 'snapshot control plane returned HTTP 400: checksum mismatch',
        },
      ]);
      expect(manifest).not.toHaveProperty('acpSessionId');
      expect(manifest).not.toHaveProperty('agentType');
      expect(sqlite.prepare(`SELECT capture_error FROM session_snapshots WHERE id = 'snapshot-1'`).get()).toEqual({
        capture_error: null,
      });
    } finally {
      sqlite.close();
    }
  });
});
