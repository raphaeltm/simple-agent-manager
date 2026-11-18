import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { instantTranscriptFallbackStart } from '../../../src/services/instant-transcript-fallback';
import { serializeSessionSleepFallbackRecord } from '../../../src/services/session-sleep-episode';
import { createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

describe('Instant transcript-only continuation', () => {
  let sqlite: Database.Database;
  let env: Env;
  const input = {
    workspaceId: 'workspace-1',
    nodeId: 'node-1',
    projectId: 'project-1',
    userId: 'user-1',
    chatSessionId: 'chat-1',
    agentSessionId: 'agent-1',
    startedAt: 42,
    contract: {
      version: 1,
      agentType: 'codex',
      settingsResolved: true,
      model: 'gpt-6.1-sol',
      effort: 'xhigh',
      permissionMode: 'default',
      opencodeProvider: null,
      opencodeBaseUrl: null,
      promptKind: 'conversation',
      taskContext: null,
    },
    mcpServers: [{ name: 'sam-mcp', url: 'https://api.example.test/mcp', token: 'new-mcp-token' }],
  } as Parameters<typeof instantTranscriptFallbackStart>[1];
  beforeEach(() => {
    sqlite = new Database(':memory:');
    createSchemaTables(sqlite, [schema.sessionSnapshots]);
    env = { DATABASE: createSqliteD1(sqlite) } as Env;
    sqlite
      .prepare(
        `INSERT INTO session_snapshots (id, workspace_id, node_id, project_id, user_id,
      chat_session_id, runtime, status, degradation, sleeping_at, sleep_fallback_json, created_at, updated_at, agent_session_id, sleep_status, expires_at)
      VALUES ('snapshot-1','workspace-1','node-1','project-1','user-1','chat-1','cf-container',
      'degraded','transcript-only','2026-10-19T00:00:00Z',?,'2026-10-19T00:00:00Z','2026-10-19T00:00:00Z','agent-1','sleeping','2099-01-01T00:00:00Z')`
      )
      .run(
        serializeSessionSleepFallbackRecord({
          version: 1,
          outcome: 'slept',
          trigger: 'attempt_budget',
          blockedReason: null,
          decidedAt: '2026-10-19T00:00:00Z',
          episodeStartedAt: '2026-10-18T23:45:00Z',
          failedAttempts: 3,
          lastError: 'snapshot incomplete',
          recoveryPoint: null,
        })
      );
  });
  afterEach(() => sqlite.close());

  it('builds a fresh start with the saved runtime settings and conversation bootstrap', async () => {
    const result = await instantTranscriptFallbackStart(env, input);
    expect(result).toMatchObject({
      agentType: 'codex',
      model: 'gpt-6.1-sol',
      effort: 'xhigh',
      protocolVersion: 1,
      deliveryId: 'sleep-fallback-agent-1-42',
      mcpServers: input.mcpServers,
    });
    expect(result?.initialPrompt).toMatch(/conversation|transcript/i);
    expect(result?.initialPrompt).not.toMatch(/SAM restored commit/);
    expect(result?.injectedInstructions).toBeTruthy();
    expect(sqlite.prepare('SELECT count(*) FROM session_snapshots').pluck().get()).toBe(1);
  });

  it.each([
    'workspaceId',
    'nodeId',
    'projectId',
    'userId',
    'chatSessionId',
    'agentSessionId',
  ] as const)(
    'refuses mismatched %s instead of using another runtime recovery record',
    async (field) => {
      await expect(
        instantTranscriptFallbackStart(env, { ...input, [field]: 'other' })
      ).resolves.toBeNull();
    }
  );

  it('refuses stale fallback metadata once the sleeping episode has ended', async () => {
    sqlite.prepare('UPDATE session_snapshots SET sleeping_at = NULL').run();
    await expect(instantTranscriptFallbackStart(env, input)).resolves.toBeNull();
  });

  it.each([
    "expires_at = '2000-01-01T00:00:00Z'",
    "expires_at = 'invalid'",
    "sleep_status = 'purging'",
    "runtime = 'vm'",
  ])('does not start outside the retained sleeping Instant episode: %s', async (state) => {
    sqlite.prepare(`UPDATE session_snapshots SET ${state}`).run();
    await expect(instantTranscriptFallbackStart(env, input)).resolves.toBeNull();
  });

  it('requires a resolved runtime contract before starting fresh', async () => {
    await expect(instantTranscriptFallbackStart(env, { ...input, contract: null })).rejects.toThrow(
      /contract unavailable/
    );
  });
});
