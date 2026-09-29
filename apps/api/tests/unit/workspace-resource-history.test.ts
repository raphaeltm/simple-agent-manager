import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import * as schema from '../../src/db/schema';
import type { Env } from '../../src/env';
import {
  deleteWorkspaceResourceHistoryObjectsForWorkspace,
  downsamplePreservingSpikes,
  getWorkspaceResourceHistory,
  type ResourceSamplePoint,
  runWorkspaceResourceHistoryCleanup,
  storeWorkspaceResourceChunk,
  type WorkspaceResourceUploadBody,
} from '../../src/services/workspace-resource-history';
import { createSchemaTables, createSqliteD1 } from '../helpers/sqlite-d1';

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function gzipJson(value: unknown): Promise<Uint8Array> {
  return gzipBytes(new TextEncoder().encode(JSON.stringify(value)));
}

async function gzipBytes(value: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([value]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gunzipJson(bytes: Uint8Array): Promise<unknown> {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return JSON.parse(await new Response(stream).text()) as unknown;
}

function samplePayload({ includeWorkingSet = true }: { includeWorkingSet?: boolean } = {}) {
  return {
    samples: [
      {
        t: 1_000,
        cpuMillis: 0,
        memoryBytes: 1024,
        ...(includeWorkingSet ? { memoryWorkingSetBytes: 512 } : {}),
        ioReadBytes: 0,
        ioWriteBytes: 0,
      },
      {
        t: 1_500,
        cpuMillis: 40,
        memoryBytes: 2048,
        memoryPeakBytes: 4096,
        ...(includeWorkingSet ? { memoryWorkingSetBytes: 1024 } : {}),
        ioReadBytes: 10,
        ioWriteBytes: 20,
      },
      {
        t: 2_000,
        cpuMillis: 900,
        memoryBytes: 1536,
        ...(includeWorkingSet ? { memoryWorkingSetBytes: 768 } : {}),
        ioReadBytes: 5,
        ioWriteBytes: 7,
        oom: 1,
      },
    ],
    toolSpans: [
      {
        id: 'hashed-tool-id',
        kind: 'execute',
        toolName: 'Bash',
        startedAt: 1_250,
        endedAt: 1_750,
        concurrency: 1,
      },
    ],
    gaps: [{ startedAt: 1_700, endedAt: 1_900, reason: 'sample_error' }],
    notes: ['tool spans are correlation, not causation'],
  };
}

async function uploadBody(
  overrides: Partial<WorkspaceResourceUploadBody> = {},
  payload = samplePayload()
): Promise<WorkspaceResourceUploadBody> {
  const compressed = await gzipJson(payload);
  return {
    workspaceId: 'ws-1',
    nodeId: 'node-1',
    sessionId: 'session-1',
    taskId: null,
    sourceVersion: 1,
    chunkSequence: 0,
    startedAt: 1_000,
    endedAt: 2_000,
    sampleCount: 3,
    gapCount: 1,
    toolSpanCount: 1,
    compressedBase64: base64(compressed),
    compressedBytes: compressed.byteLength,
    uncompressedBytes: JSON.stringify(payload).length,
    sha256: await sha256Hex(compressed),
    completeness: { status: 'complete' },
    summary: {
      cpuMeanMillis: (0 + 40 + 900) / 3,
      cpuPeakMillis: 900,
      memoryMeanBytes: 1536,
      memoryPeakBytes: 2048,
      memoryKernelPeakBytes: 4096,
      memoryWorkingSetMeanBytes: 768,
      memoryWorkingSetPeakBytes: 1024,
      memoryWorkingSetSampleCount: 3,
      ioReadBytes: 15,
      ioWriteBytes: 27,
      oomCount: 1,
    },
    ...overrides,
  };
}

function makeR2() {
  const objects = new Map<string, Uint8Array>();
  const puts: string[] = [];
  const deletes: string[] = [];
  return {
    objects,
    puts,
    deletes,
    binding: {
      put: async (key: string, value: Uint8Array) => {
        puts.push(key);
        objects.set(key, value);
        return null;
      },
      delete: async (key: string) => {
        deletes.push(key);
        objects.delete(key);
      },
      get: async (key: string) => {
        const value = objects.get(key);
        if (!value) return null;
        return {
          arrayBuffer: async () =>
            value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength),
          body: new Blob([value]).stream(),
        };
      },
      list: async (options?: { prefix?: string; limit?: number; cursor?: string }) => {
        const prefix = options?.prefix ?? '';
        const start = options?.cursor ? Number(options.cursor) : 0;
        const limit = options?.limit ?? 1000;
        const keys = [...objects.keys()].filter((key) => key.startsWith(prefix)).sort();
        const page = keys.slice(start, start + limit);
        const next = start + page.length;
        return {
          objects: page.map((key) => ({ key })),
          truncated: next < keys.length,
          cursor: next < keys.length ? String(next) : undefined,
        };
      },
    } as unknown as R2Bucket,
  };
}

function makeEnv(sqlite: Database.Database, r2: R2Bucket): Env {
  return {
    DATABASE: createSqliteD1(sqlite),
    PROJECT_DATA_ARCHIVE_R2: r2,
  } as unknown as Env;
}

function makePersistedResourceTestEnv() {
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
  sqlite
    .prepare(
      `INSERT INTO workspaces (id, project_id, node_id, chat_session_id)
       VALUES ('ws-1', 'proj-1', 'node-1', 'session-1')`
    )
    .run();
  const r2 = makeR2();
  return { sqlite, r2, env: makeEnv(sqlite, r2.binding) };
}

describe('workspace resource history', () => {
  it('bounds detail points while preserving first, last, gaps, and spikes', () => {
    const samples: ResourceSamplePoint[] = Array.from({ length: 20 }, (_, index) => ({
      t: index,
      cpuMillis: index === 9 ? 900 : 10,
      memoryBytes: index === 14 ? 900 * 1024 * 1024 : 16 * 1024 * 1024,
      gap: index === 5,
    }));

    const result = downsamplePreservingSpikes(samples, 6);

    expect(result.downsampled).toBe(true);
    expect(result.samples).toHaveLength(6);
    expect(result.samples[0]?.t).toBe(0);
    expect(result.samples.at(-1)?.t).toBe(19);
    expect(result.samples.some((sample) => sample.gap)).toBe(true);
    expect(result.samples.some((sample) => sample.cpuMillis === 900)).toBe(true);
    expect(result.samples.some((sample) => sample.memoryBytes === 900 * 1024 * 1024)).toBe(true);
  });

  it('deletes every workspace resource R2 object across paginated prefix scans', async () => {
    const sqlite = new Database(':memory:');
    const r2 = makeR2();
    const env = makeEnv(sqlite, r2.binding);
    for (let index = 0; index < 1001; index += 1) {
      r2.objects.set(
        `resource-history/v1/projects/proj-1/workspaces/ws-1/session/sess-1/v1/${index}.json.gz`,
        new Uint8Array([index % 255])
      );
    }
    r2.objects.set(
      'resource-history/v1/projects/proj-1/workspaces/ws-2/session/sess-1/v1/0.json.gz',
      new Uint8Array([1])
    );

    const stats = await deleteWorkspaceResourceHistoryObjectsForWorkspace(env, 'proj-1', 'ws-1');

    expect(stats).toMatchObject({ listedObjects: 1001, deletedObjects: 1001, truncated: false });
    expect([...r2.objects.keys()]).toEqual([
      'resource-history/v1/projects/proj-1/workspaces/ws-2/session/sess-1/v1/0.json.gz',
    ]);
  });

  it('aggregates working-set samples without treating old-agent omissions as zero', async () => {
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
    sqlite
      .prepare(
        `INSERT INTO workspaces (id, project_id, node_id, chat_session_id)
         VALUES ('ws-1', 'proj-1', 'node-1', 'session-1')`
      )
      .run();
    const r2 = makeR2();
    const env = makeEnv(sqlite, r2.binding);

    await storeWorkspaceResourceChunk(env, 'proj-1', await uploadBody(), 'node-1');
    await storeWorkspaceResourceChunk(
      env,
      'proj-1',
      await uploadBody({
        chunkSequence: 1,
        startedAt: 2_001,
        endedAt: 3_000,
        sampleCount: 2,
        summary: {
          memoryWorkingSetMeanBytes: 1536,
          memoryWorkingSetPeakBytes: 2048,
          memoryWorkingSetSampleCount: 2,
        },
      }),
      'node-1'
    );
    await storeWorkspaceResourceChunk(
      env,
      'proj-1',
      await uploadBody({
        chunkSequence: 2,
        startedAt: 3_001,
        endedAt: 4_000,
        summary: {},
      }),
      'node-1'
    );

    const history = await getWorkspaceResourceHistory(env, {
      projectId: 'proj-1',
      sessionId: 'session-1',
    });
    expect(history.summary).toMatchObject({
      sampleCount: 8,
      memoryWorkingSetMeanBytes: 1075,
      memoryWorkingSetPeakBytes: 2048,
    });
    expect(
      sqlite
        .prepare(
          `SELECT memory_working_set_sample_count AS count
             FROM workspace_resource_summaries`
        )
        .get()
    ).toEqual({ count: 5 });
  });

  it('keeps working-set summary fields null for old-agent uploads', async () => {
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
    sqlite
      .prepare(
        `INSERT INTO workspaces (id, project_id, node_id, chat_session_id)
         VALUES ('ws-1', 'proj-1', 'node-1', 'session-1')`
      )
      .run();
    const r2 = makeR2();
    const env = makeEnv(sqlite, r2.binding);

    const oldAgentPayload = samplePayload({ includeWorkingSet: false });
    const stored = await storeWorkspaceResourceChunk(
      env,
      'proj-1',
      await uploadBody({ summary: {} }, oldAgentPayload),
      'node-1'
    );

    const history = await getWorkspaceResourceHistory(env, {
      projectId: 'proj-1',
      sessionId: 'session-1',
      detailChunkId: stored.chunkId,
    });
    expect(history.summary).toMatchObject({
      memoryWorkingSetMeanBytes: null,
      memoryWorkingSetPeakBytes: null,
    });
    expect(history.detail?.samples).toHaveLength(3);
    expect(history.detail?.samples.every((sample) => sample.memoryWorkingSetBytes == null)).toBe(
      true
    );
  });

  it('initializes working-set aggregates when a new-agent chunk follows old-agent history', async () => {
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
    sqlite
      .prepare(
        `INSERT INTO workspaces (id, project_id, node_id, chat_session_id)
         VALUES ('ws-1', 'proj-1', 'node-1', 'session-1')`
      )
      .run();
    const r2 = makeR2();
    const env = makeEnv(sqlite, r2.binding);

    await storeWorkspaceResourceChunk(
      env,
      'proj-1',
      await uploadBody({ summary: {} }, samplePayload({ includeWorkingSet: false })),
      'node-1'
    );
    await storeWorkspaceResourceChunk(
      env,
      'proj-1',
      await uploadBody({ chunkSequence: 1, startedAt: 2_001, endedAt: 3_000 }),
      'node-1'
    );

    const history = await getWorkspaceResourceHistory(env, {
      projectId: 'proj-1',
      sessionId: 'session-1',
    });
    expect(history.summary).toMatchObject({
      sampleCount: 6,
      memoryWorkingSetMeanBytes: 768,
      memoryWorkingSetPeakBytes: 1024,
    });
    expect(
      sqlite
        .prepare(
          `SELECT memory_working_set_sample_count AS count
             FROM workspace_resource_summaries`
        )
        .get()
    ).toEqual({ count: 3 });
  });

  it('keeps separate bounded summaries for reused workspace sessions while indexing raw chunks in R2', async () => {
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
    sqlite
      .prepare(
        `INSERT INTO workspaces (id, project_id, node_id, chat_session_id, agent_profile_hint)
         VALUES ('ws-1', 'proj-1', 'node-1', 'session-1', 'profile-1')`
      )
      .run();
    const r2 = makeR2();
    const env = makeEnv(sqlite, r2.binding);

    const firstBody = await uploadBody();
    const first = await storeWorkspaceResourceChunk(env, 'proj-1', firstBody, 'node-1');
    const firstRetry = await storeWorkspaceResourceChunk(env, 'proj-1', firstBody, 'node-1');

    const differentPayload = await gzipJson({ samples: [], toolSpans: [], gaps: [] });
    await expect(
      storeWorkspaceResourceChunk(
        env,
        'proj-1',
        await uploadBody({
          sessionId: 'session-1',
          compressedBase64: base64(differentPayload),
          compressedBytes: differentPayload.byteLength,
          uncompressedBytes: JSON.stringify({ samples: [], toolSpans: [], gaps: [] }).length,
          sha256: await sha256Hex(differentPayload),
        }),
        'node-1'
      )
    ).rejects.toThrow(/different checksum/i);
    sqlite.prepare(`UPDATE workspaces SET chat_session_id = 'session-2' WHERE id = 'ws-1'`).run();
    await expect(storeWorkspaceResourceChunk(env, 'proj-1', firstBody, 'node-1')).rejects.toThrow(
      /Session identity does not match workspace/i
    );
    const second = await storeWorkspaceResourceChunk(
      env,
      'proj-1',
      await uploadBody({
        sessionId: 'session-2',
        chunkSequence: 0,
        startedAt: 2_000,
        endedAt: 3_000,
      }),
      'node-1'
    );

    expect(first.summaryId).toContain('session:session-1');
    expect(second.summaryId).toContain('session:session-2');
    expect(first.summaryId).not.toBe(second.summaryId);
    expect(first.chunkId).not.toBe(second.chunkId);
    expect(firstRetry).toMatchObject({ chunkId: first.chunkId, idempotent: true });
    expect(r2.puts).toHaveLength(2);

    const history = await getWorkspaceResourceHistory(env, {
      projectId: 'proj-1',
      sessionId: 'session-1',
      detailChunkId: first.chunkId,
    });
    expect(history.summary).toMatchObject({
      id: first.summaryId,
      sessionId: 'session-1',
      sampleCount: 3,
    });
    expect(history.chunks).toHaveLength(1);
    expect(history.detail).toMatchObject({
      chunkId: first.chunkId,
      originalSampleCount: 3,
      downsampled: false,
      toolSpans: [
        expect.objectContaining({ id: 'hashed-tool-id', kind: 'execute', toolName: 'Bash' }),
      ],
      gaps: [expect.objectContaining({ reason: 'sample_error' })],
    });
    expect(history.detail?.samples.some((sample) => sample.cpuMillis === 900)).toBe(true);
    expect(history.detail?.samples.some((sample) => sample.memoryWorkingSetBytes === 1024)).toBe(
      true
    );

    const summaries = sqlite
      .prepare(
        `SELECT id, session_id, sample_count, latest_chunk_id
           FROM workspace_resource_summaries
          ORDER BY session_id`
      )
      .all() as Array<Record<string, unknown>>;
    expect(summaries).toEqual([
      expect.objectContaining({ id: first.summaryId, session_id: 'session-1', sample_count: 3 }),
      expect.objectContaining({ id: second.summaryId, session_id: 'session-2', sample_count: 3 }),
    ]);
    const chunks = sqlite
      .prepare(
        `SELECT id, summary_id, session_id FROM workspace_resource_chunks ORDER BY session_id`
      )
      .all() as Array<Record<string, unknown>>;
    expect(chunks).toEqual([
      expect.objectContaining({ summary_id: first.summaryId, session_id: 'session-1' }),
      expect.objectContaining({ summary_id: second.summaryId, session_id: 'session-2' }),
    ]);
  });

  it('resolves distinct server attribution per session without leaking a foreign-project task', async () => {
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
      INSERT INTO agent_profiles (id, project_id, agent_type) VALUES
        ('profile-a', 'proj-1', 'openai-codex'),
        ('profile-b', 'proj-1', 'claude-code'),
        ('profile-foreign', 'proj-2', 'foreign-agent');
      INSERT INTO skills (id, project_id, agent_type) VALUES
        ('skill-a', 'proj-1', 'openai-codex'),
        ('skill-b', 'proj-1', 'claude-code'),
        ('skill-foreign', 'proj-2', 'foreign-agent');
      INSERT INTO workspaces (id, project_id, node_id, chat_session_id) VALUES
        ('ws-a', 'proj-1', 'node-a', 'session-a'),
        ('ws-b', 'proj-1', 'node-b', 'session-b'),
        ('ws-foreign-guard', 'proj-1', 'node-c', 'session-c'),
        ('ws-dangling', 'proj-1', 'node-d', 'session-d');
      INSERT INTO agent_sessions
        (id, workspace_id, status, agent_type, agent_profile_id, skill_id, created_at, updated_at)
      VALUES
        ('agent-session-a', 'ws-a', 'running', 'openai-codex', 'profile-a', 'skill-a',
         '2026-09-29T00:00:00.000Z', '2026-09-29T00:00:00.000Z'),
        ('agent-session-b-conflict', 'ws-b', 'running', 'openai-codex', 'profile-a', 'skill-a',
         '2026-09-29T01:00:00.000Z', '2026-09-29T01:00:00.000Z');
      INSERT INTO tasks
        (id, project_id, workspace_id, chat_session_id, agent_profile_hint, skill_id, started_at)
      VALUES
        ('task-b', 'proj-1', 'ws-b', 'session-b', 'profile-b', 'skill-b',
         '2026-09-29T00:00:00.000Z'),
        ('task-local-foreign-hints', 'proj-1', 'ws-foreign-guard', 'session-c',
         'profile-foreign', 'skill-foreign', '2026-09-29T00:30:00.000Z'),
        ('task-dangling', 'proj-1', 'ws-dangling', 'session-d',
         'missing-profile', 'missing-skill', '2026-09-29T00:30:00.000Z'),
        ('task-foreign', 'proj-2', 'ws-foreign-guard', 'session-c',
         'profile-foreign', 'skill-foreign', '2026-09-29T00:00:00.000Z');
    `);
    const r2 = makeR2();
    const env = makeEnv(sqlite, r2.binding);

    await storeWorkspaceResourceChunk(
      env,
      'proj-1',
      await uploadBody({
        workspaceId: 'ws-a',
        nodeId: 'node-a',
        sessionId: 'session-a',
        agentProfileId: 'profile-foreign',
        skillId: 'skill-foreign',
        agentType: 'foreign-agent',
      }),
      'node-a'
    );
    await storeWorkspaceResourceChunk(
      env,
      'proj-1',
      await uploadBody({
        workspaceId: 'ws-b',
        nodeId: 'node-b',
        sessionId: 'session-b',
        taskId: 'task-b',
        agentProfileId: 'profile-foreign',
        skillId: 'skill-foreign',
        agentType: 'foreign-agent',
      }),
      'node-b'
    );
    await expect(
      storeWorkspaceResourceChunk(
        env,
        'proj-1',
        await uploadBody({
          workspaceId: 'ws-foreign-guard',
          nodeId: 'node-c',
          sessionId: 'session-c',
          taskId: 'task-foreign',
        }),
        'node-c'
      )
    ).rejects.toThrow(/Task identity does not match workspace session/i);
    await storeWorkspaceResourceChunk(
      env,
      'proj-1',
      await uploadBody({
        workspaceId: 'ws-foreign-guard',
        nodeId: 'node-c',
        sessionId: 'session-c',
        taskId: null,
        agentProfileId: 'profile-foreign',
        skillId: 'skill-foreign',
        agentType: 'foreign-agent',
      }),
      'node-c'
    );
    await storeWorkspaceResourceChunk(
      env,
      'proj-1',
      await uploadBody({
        workspaceId: 'ws-dangling',
        nodeId: 'node-d',
        sessionId: 'session-d',
        taskId: 'task-dangling',
      }),
      'node-d'
    );

    const [historyA, historyB, guardedHistory, danglingHistory] = await Promise.all([
      getWorkspaceResourceHistory(env, { projectId: 'proj-1', sessionId: 'session-a' }),
      getWorkspaceResourceHistory(env, { projectId: 'proj-1', sessionId: 'session-b' }),
      getWorkspaceResourceHistory(env, { projectId: 'proj-1', sessionId: 'session-c' }),
      getWorkspaceResourceHistory(env, { projectId: 'proj-1', sessionId: 'session-d' }),
    ]);
    expect(historyA.summary).toMatchObject({
      agentProfileId: 'profile-a',
      skillId: 'skill-a',
      agentType: 'openai-codex',
    });
    expect(historyB.summary).toMatchObject({
      taskId: 'task-b',
      agentProfileId: 'profile-b',
      skillId: 'skill-b',
      agentType: 'claude-code',
    });
    expect(guardedHistory.summary).toMatchObject({
      taskId: 'task-local-foreign-hints',
      agentProfileId: null,
      skillId: null,
      agentType: null,
    });
    expect(danglingHistory.summary).toMatchObject({
      taskId: 'task-dangling',
      agentProfileId: null,
      skillId: null,
      agentType: null,
    });
  });

  it('caps and allowlists decoded tool metadata while preserving legacy spans', async () => {
    const { env, r2 } = makePersistedResourceTestEnv();
    env.WORKSPACE_RESOURCE_TOOL_NAME_MAX_BYTES = '8';
    const commandCanary = 'printf super-secret-command';
    const payload = {
      samples: [{ t: 1_000 }],
      toolSpans: [
        {
          id: 'named',
          kind: 'execute',
          toolName: 'Bash🔥unsafe',
          title: commandCanary,
          rawInput: { command: commandCanary },
          startedAt: 1_000,
          endedAt: 2_000,
        },
        { id: 'invalid-kind', kind: 'command', toolName: 'Bad\u0000Name', startedAt: 1_100 },
        { id: 'legacy', startedAt: 1_200, endedAt: 1_300 },
      ],
      gaps: [],
    };
    const compressed = await gzipJson(payload);
    const result = await storeWorkspaceResourceChunk(
      env,
      'proj-1',
      await uploadBody({
        sampleCount: 1,
        gapCount: 0,
        toolSpanCount: 3,
        compressedBase64: base64(compressed),
        compressedBytes: compressed.byteLength,
        uncompressedBytes: new TextEncoder().encode(JSON.stringify(payload)).byteLength,
        sha256: await sha256Hex(compressed),
      }),
      'node-1'
    );

    const history = await getWorkspaceResourceHistory(env, {
      projectId: 'proj-1',
      sessionId: 'session-1',
      detailChunkId: result.chunkId,
    });

    expect(history.detail?.toolSpans).toEqual([
      {
        id: 'named',
        kind: 'execute',
        toolName: 'Bash🔥',
        startedAt: 1_000,
        endedAt: 2_000,
      },
      { id: 'invalid-kind', startedAt: 1_100 },
      { id: 'legacy', startedAt: 1_200, endedAt: 1_300 },
    ]);
    expect(JSON.stringify(history.detail?.toolSpans)).not.toContain(commandCanary);

    const archivedBytes = [...r2.objects.values()][0];
    expect(archivedBytes).toBeDefined();
    const archivedPayload = await gunzipJson(archivedBytes!);
    expect(archivedPayload).toMatchObject({
      toolSpans: [
        {
          id: 'named',
          kind: 'execute',
          toolName: 'Bash🔥',
          startedAt: 1_000,
          endedAt: 2_000,
        },
        { id: 'invalid-kind', startedAt: 1_100 },
        { id: 'legacy', startedAt: 1_200, endedAt: 1_300 },
      ],
    });
    expect(JSON.stringify(archivedPayload)).not.toContain(commandCanary);
    expect(JSON.stringify(archivedPayload)).not.toContain('unsafe');
  });

  it('rejects mismatched decoded size and oversized D1 metadata before indexing', async () => {
    const { env, r2, sqlite } = makePersistedResourceTestEnv();

    await expect(
      storeWorkspaceResourceChunk(
        env,
        'proj-1',
        await uploadBody({ uncompressedBytes: 1 }),
        'node-1'
      )
    ).rejects.toThrow(/uncompressedBytes does not match/i);

    await expect(
      storeWorkspaceResourceChunk(
        { ...env, WORKSPACE_RESOURCE_METADATA_MAX_BYTES: '16' },
        'proj-1',
        await uploadBody({ completeness: { status: 'complete', long: 'x'.repeat(64) } }),
        'node-1'
      )
    ).rejects.toThrow(/completeness exceeds/i);

    expect(sqlite.prepare(`SELECT COUNT(*) AS count FROM workspace_resource_chunks`).get()).toEqual(
      { count: 0 }
    );
    expect(r2.objects.size).toBe(0);
  });

  it('rejects invalid UTF-8 before normalizing and archiving a chunk', async () => {
    const { env, r2 } = makePersistedResourceTestEnv();
    const invalidJsonBytes = new Uint8Array([
      ...new TextEncoder().encode('{"samples":[],"notes":["'),
      0xff,
      ...new TextEncoder().encode('"]}'),
    ]);
    const compressed = await gzipBytes(invalidJsonBytes);

    await expect(
      storeWorkspaceResourceChunk(
        env,
        'proj-1',
        await uploadBody({
          sampleCount: 0,
          gapCount: 0,
          toolSpanCount: 0,
          compressedBase64: base64(compressed),
          compressedBytes: compressed.byteLength,
          uncompressedBytes: invalidJsonBytes.byteLength,
          sha256: await sha256Hex(compressed),
        }),
        'node-1'
      )
    ).rejects.toThrow(/gzip-compressed JSON/i);
    expect(r2.objects.size).toBe(0);
  });

  it('cleans up expired R2 chunks and old summaries within the configured batch', async () => {
    const { env, r2, sqlite } = makePersistedResourceTestEnv();

    await storeWorkspaceResourceChunk(env, 'proj-1', await uploadBody(), 'node-1');
    expect(r2.objects.size).toBe(1);
    sqlite.prepare(`UPDATE workspace_resource_chunks SET expires_at = 1`).run();
    sqlite.prepare(`UPDATE workspace_resource_summaries SET updated_at = 1`).run();

    const stats = await runWorkspaceResourceHistoryCleanup(
      {
        ...env,
        WORKSPACE_RESOURCE_SUMMARY_RETENTION_DAYS: '1',
        WORKSPACE_RESOURCE_CLEANUP_BATCH_SIZE: '10',
      },
      3 * 24 * 60 * 60 * 1000
    );

    expect(stats).toMatchObject({
      expiredChunksSelected: 1,
      expiredChunksDeleted: 1,
      summariesSelected: 1,
      summariesDeleted: 1,
    });
    expect(r2.objects.size).toBe(0);
    expect(sqlite.prepare(`SELECT COUNT(*) AS count FROM workspace_resource_chunks`).get()).toEqual(
      {
        count: 0,
      }
    );
    expect(
      sqlite.prepare(`SELECT COUNT(*) AS count FROM workspace_resource_summaries`).get()
    ).toEqual({ count: 0 });
  });

  it('deletes the uploaded R2 object when D1 indexing fails', async () => {
    const sqlite = new Database(':memory:');
    createSchemaTables(sqlite, [
      schema.workspaces,
      schema.tasks,
      schema.agentSessions,
      schema.agentProfiles,
      schema.skills,
      schema.workspaceResourceChunks,
    ]);
    sqlite
      .prepare(
        `INSERT INTO workspaces (id, project_id, node_id, chat_session_id)
         VALUES ('ws-1', 'proj-1', 'node-1', 'session-1')`
      )
      .run();
    const r2 = makeR2();
    const env = makeEnv(sqlite, r2.binding);

    await expect(
      storeWorkspaceResourceChunk(env, 'proj-1', await uploadBody(), 'node-1')
    ).rejects.toThrow(/workspace_resource_summaries/i);

    expect(r2.puts).toHaveLength(1);
    expect(r2.deletes).toEqual(r2.puts);
    expect(r2.objects.size).toBe(0);
  });
});
