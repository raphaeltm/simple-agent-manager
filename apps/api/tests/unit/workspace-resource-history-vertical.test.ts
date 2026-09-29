import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';

import * as schema from '../../src/db/schema';
import type { Env } from '../../src/env';
import { handleAppError } from '../../src/middleware/app-error-handler';
import { workspaceResourceHistoryCallbackRoute } from '../../src/routes/projects/workspace-resource-history-callback';
import { verifyCallbackToken } from '../../src/services/jwt';
import { getWorkspaceResourceHistory } from '../../src/services/workspace-resource-history';
import { base64, gzipText, sha256Hex } from '../helpers/resource-history';
import { createSchemaTables, createSqliteD1 } from '../helpers/sqlite-d1';

vi.mock('../../src/services/jwt', () => ({
  verifyCallbackToken: vi.fn(),
}));

describe('workspace resource history vertical slice', () => {
  it('resolves server attribution through the callback and exposes the persisted summary', async () => {
    const sqlite = new Database(':memory:');
    createSchemaTables(sqlite, [
      schema.workspaces,
      schema.tasks,
      schema.agentSessions,
      schema.agentProfiles,
      schema.skills,
      schema.workspaceResourceSummaries,
      schema.workspaceResourceChunks,
    ]);
    sqlite.exec(`
      INSERT INTO agent_profiles (id, project_id, agent_type)
      VALUES ('profile-task', 'project-1', 'openai-codex'),
             ('profile-client', 'project-2', 'foreign-agent');
      INSERT INTO skills (id, project_id, agent_type)
      VALUES ('skill-task', 'project-1', 'openai-codex'),
             ('skill-client', 'project-2', 'foreign-agent');
      INSERT INTO workspaces (id, project_id, node_id, chat_session_id)
      VALUES ('workspace-1', 'project-1', 'node-1', 'session-1');
      INSERT INTO tasks
        (id, project_id, workspace_id, chat_session_id, agent_profile_hint, skill_id, started_at)
      VALUES
        ('task-1', 'project-1', 'workspace-1', 'session-1',
         'profile-task', 'skill-task', '2026-09-29T00:00:00.000Z');
    `);

    const samples = JSON.stringify({ samples: [{ t: 1, cpuMillis: 1, memoryBytes: 2 }] });
    const compressed = await gzipText(samples);
    const storedObjects = new Map<string, Uint8Array>();
    const env = {
      DATABASE: createSqliteD1(sqlite),
      PROJECT_DATA_ARCHIVE_R2: {
        put: async (key: string, value: Uint8Array) => {
          storedObjects.set(key, value);
          return null;
        },
        delete: async (key: string) => {
          storedObjects.delete(key);
        },
      },
    } as unknown as Env;
    vi.mocked(verifyCallbackToken).mockResolvedValue({
      workspace: 'node-1',
      type: 'callback',
      scope: 'node',
    });

    const app = new Hono<{ Bindings: Env }>();
    app.onError(handleAppError);
    app.route('/api/projects', workspaceResourceHistoryCallbackRoute);
    const response = await app.request(
      '/api/projects/project-1/workspace-resource-history',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceId: 'workspace-1',
          nodeId: 'node-1',
          sessionId: 'session-1',
          taskId: 'task-1',
          agentProfileId: 'profile-client',
          skillId: 'skill-client',
          agentType: 'foreign-agent',
          sourceVersion: 1,
          chunkSequence: 0,
          startedAt: 1,
          endedAt: 1,
          sampleCount: 1,
          gapCount: 0,
          toolSpanCount: 0,
          compressedBase64: base64(compressed),
          compressedBytes: compressed.byteLength,
          uncompressedBytes: samples.length,
          sha256: await sha256Hex(compressed),
          completeness: { status: 'complete' },
          summary: { cpuPeakMillis: 1, memoryPeakBytes: 2 },
        }),
      },
      env
    );

    expect(response.status).toBe(200);
    expect(storedObjects.size).toBe(1);
    const history = await getWorkspaceResourceHistory(env, {
      projectId: 'project-1',
      sessionId: 'session-1',
    });
    expect(history.summary).toMatchObject({
      taskId: 'task-1',
      agentProfileId: 'profile-task',
      skillId: 'skill-task',
      agentType: 'openai-codex',
    });
  });
});
