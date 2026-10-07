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

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('concurrent resource-history callback uploads', () => {
  it.each([false, true])(
    'preserves one committed chunk and delta (checksum conflict: %s)',
    async (conflict) => {
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
      sqlite.exec(`INSERT INTO workspaces (id, project_id, node_id, chat_session_id)
      VALUES ('workspace-1', 'project-1', 'node-1', 'session-1')`);
      // Add production's immediate summary FK and object-key uniqueness, which
      // the narrow schema helper deliberately omits.
      const ddl = sqlite
        .prepare("SELECT sql FROM sqlite_master WHERE name='workspace_resource_chunks'")
        .get() as { sql: string };
      sqlite.exec('DROP TABLE workspace_resource_chunks');
      sqlite.exec(
        ddl.sql.replace(
          '"summary_id" text',
          '"summary_id" text REFERENCES workspace_resource_summaries(id) ON DELETE SET NULL'
        )
      );
      sqlite.exec(
        'PRAGMA foreign_keys = ON; CREATE UNIQUE INDEX chunk_r2_key ON workspace_resource_chunks(r2_key)'
      );
      const objects = new Map<string, Uint8Array>();
      const arrived = deferred();
      const release = deferred();
      let puts = 0;
      const env = {
        DATABASE: createSqliteD1(sqlite),
        PROJECT_DATA_ARCHIVE_R2: {
          put: async (key: string, bytes: Uint8Array) => {
            objects.set(key, bytes);
            if (++puts === 1) {
              arrived.resolve();
              await release.promise;
            }
            return null;
          },
          delete: async (key: string) => {
            objects.delete(key);
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
      const upload = async (cpu: number) => {
        const payload = JSON.stringify({
          samples: [{ t: 1, cpuMillis: cpu, memoryBytes: 2 }],
          toolSpans: [{ id: 'hashed-tool', startedAt: 1, endedAt: 1 }],
          gaps: [],
        });
        const compressed = await gzipText(payload);
        return app.request(
          '/api/projects/project-1/workspace-resource-history',
          {
            method: 'POST',
            headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
            body: JSON.stringify({
              workspaceId: 'workspace-1',
              nodeId: 'node-1',
              sessionId: 'session-1',
              sourceVersion: 1,
              chunkSequence: 0,
              startedAt: 1,
              endedAt: 1,
              sampleCount: 1,
              toolSpanCount: 1,
              compressedBase64: base64(compressed),
              compressedBytes: compressed.byteLength,
              uncompressedBytes: payload.length,
              sha256: await sha256Hex(compressed),
              completeness: { finalFlush: true },
              summary: {
                cpuMeanMillis: cpu,
                cpuPeakMillis: cpu,
                ioReadBytes: 7,
                memoryWorkingSetMeanBytes: 2,
                memoryWorkingSetSampleCount: 1,
              },
            }),
          },
          env
        );
      };
      try {
        const losing = upload(1);
        await arrived.promise;
        const winner = await upload(conflict ? 3 : 1);
        expect(winner.status).toBe(200);
        release.resolve();
        const loser = await losing;
        expect(loser.status).toBe(conflict ? 409 : 200);
        if (!conflict) expect(await loser.json()).toMatchObject({ idempotent: true });
        expect(sqlite.prepare('SELECT COUNT(*) AS n FROM workspace_resource_chunks').get()).toEqual(
          { n: 1 }
        );
        const summary = sqlite
          .prepare(
            'SELECT sample_count, tool_span_count, io_read_bytes, memory_working_set_sample_count, cpu_mean_millis FROM workspace_resource_summaries'
          )
          .get();
        expect(summary).toEqual({
          sample_count: 1,
          tool_span_count: 1,
          io_read_bytes: 7,
          memory_working_set_sample_count: 1,
          cpu_mean_millis: conflict ? 3 : 1,
        });
        const chunk = sqlite
          .prepare('SELECT r2_key, sha256 FROM workspace_resource_chunks')
          .get() as { r2_key: string; sha256: string };
        expect(objects.size).toBe(1);
        expect(objects.has(chunk.r2_key)).toBe(true);
        expect(await sha256Hex(objects.get(chunk.r2_key)!)).toBe(chunk.sha256);
      } finally {
        release.resolve();
        sqlite.close();
      }
    }
  );
});
