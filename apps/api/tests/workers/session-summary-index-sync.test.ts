/**
 * ProjectData -> D1 session index sync, against a real Durable Object.
 *
 * Two things are proven here:
 *
 *  1. The sync produces an index the per-project sidebar read can actually use —
 *     creator, created_at, the unresolved attention marker, and a coverage row
 *     that says whether every session was captured.
 *  2. It stays EQUIVALENT to the DO's own `listSessions`. The whole design rests
 *     on the two paths agreeing, so a divergence has to be a test failure rather
 *     than a subtly wrong sidebar in production.
 */
import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

import { listSessionsFromIndex } from '../../src/services/session-summary-index';
import type { Env as WorkerEnv } from '../../src/env';
import { seedInstallation, seedProject, seedUser } from './helpers/seed-d1';
import { type ProjectDataTestDouble } from './support/expected-error-doubles';

function getStub(projectId: string): DurableObjectStub<ProjectDataTestDouble> {
  const id = env.PROJECT_DATA.idFromName(projectId);
  return env.PROJECT_DATA.get(id) as DurableObjectStub<ProjectDataTestDouble>;
}

const OWNER = 'user-index-owner';
const INSTALLATION = 'inst-index';

async function seed(projectId: string): Promise<void> {
  await seedUser(OWNER);
  await seedInstallation(INSTALLATION, OWNER);
  await seedProject(projectId, OWNER, INSTALLATION);
}

async function readCoverage(projectId: string) {
  return env.DATABASE.prepare(
    'SELECT synced_at, session_count, complete FROM session_index_coverage WHERE project_id = ?'
  )
    .bind(projectId)
    .first<{ synced_at: number; session_count: number; complete: number }>();
}

describe('D1 session index sync', () => {
  let projectId: string;
  let counter = 0;

  beforeEach(() => {
    counter += 1;
    projectId = `project-index-${counter}`;
  });

  it('writes a complete coverage row alongside the session rows', async () => {
    await seed(projectId);
    const stub = getStub(projectId);
    await stub.ensureProjectId(projectId);
    await stub.createSession('workspace-1', 'First chat');
    await stub.createSession('workspace-2', 'Second chat');

    await stub.runSummarySyncForTest();

    const coverage = await readCoverage(projectId);
    expect(coverage?.session_count).toBe(2);
    expect(coverage?.complete).toBe(1);
    expect(coverage?.synced_at).toBeGreaterThan(0);
  });

  it('marks coverage incomplete when the project exceeds the row cap', async () => {
    await seed(projectId);
    const stub = getStub(projectId);
    await stub.ensureProjectId(projectId);
    await stub.createSession('workspace-1', 'One');
    await stub.createSession('workspace-2', 'Two');
    await stub.createSession('workspace-3', 'Three');

    // Cap below the session count — the mirror cannot be complete.
    const cappedEnv = { ...env, SESSION_INDEX_MAX_ROWS: '2' };
    const cappedStub = env.PROJECT_DATA.get(
      env.PROJECT_DATA.idFromName(projectId)
    ) as DurableObjectStub<ProjectDataTestDouble>;
    await cappedStub.runSummarySyncWithEnvForTest({ SESSION_INDEX_MAX_ROWS: '2' });

    const coverage = await readCoverage(projectId);
    expect(coverage?.session_count).toBe(3);
    expect(coverage?.complete).toBe(0);

    // And the read path must refuse to serve from an incomplete index.
    const out = await listSessionsFromIndex(cappedEnv as unknown as WorkerEnv, {
      projectId,
      status: null,
      limit: 20,
      offset: 0,
      createdByUserId: null,
    });
    expect(out).toEqual({ missReason: 'incomplete_coverage' });
  });

  it('produces the same rows the Durable Object listSessions returns', async () => {
    await seed(projectId);
    const stub = getStub(projectId);
    await stub.ensureProjectId(projectId);
    const sessionA = await stub.createSession('workspace-a', 'Chat A', undefined, OWNER);
    await stub.createSession('workspace-b', 'Chat B', undefined, OWNER);
    await stub.markAgentCompleted(sessionA);

    await stub.runSummarySyncForTest();

    const fromDo = await stub.listSessions(null, 20, 0, null, null);
    const fromIndex = await listSessionsFromIndex(env as unknown as WorkerEnv, {
      projectId,
      status: null,
      limit: 20,
      offset: 0,
      createdByUserId: null,
    });

    if (!('result' in fromIndex)) {
      throw new Error(`index read missed: ${fromIndex.missReason}`);
    }

    expect(fromIndex.result.total).toBe(fromDo.total);
    expect(fromIndex.result.hasMore).toBe(fromDo.hasMore);
    expect(fromIndex.result.sessions.map((s) => s.id)).toEqual(fromDo.sessions.map((s) => s.id));

    // Field-by-field parity on every key the sidebar reads. `attention` is
    // compared separately below because the DO adds it via enrichment.
    const parityKeys = [
      'id',
      'workspaceId',
      'taskId',
      'createdByUserId',
      'topic',
      'status',
      'messageCount',
      'startedAt',
      'endedAt',
      'createdAt',
      'agentCompletedAt',
      'lastMessageAt',
      'isIdle',
      'isTerminated',
      'workspaceUrl',
      'cleanupAt',
    ];
    for (const [i, doRow] of fromDo.sessions.entries()) {
      const indexRow = fromIndex.result.sessions[i];
      for (const key of parityKeys) {
        expect({ key, value: indexRow?.[key] }).toEqual({ key, value: doRow[key] });
      }
    }
  });

  it('mirrors the unresolved attention marker so the sidebar badge survives', async () => {
    await seed(projectId);
    const stub = getStub(projectId);
    await stub.ensureProjectId(projectId);
    const sessionId = await stub.createSession('workspace-1', 'Needs input');
    await stub.createAttentionMarker({
      sessionId,
      taskId: null,
      workspaceId: 'workspace-1',
      kind: 'needs_input',
      source: 'agent',
      reason: 'Waiting on you',
    });

    await stub.runSummarySyncForTest();

    const fromDo = await stub.listSessions(null, 20, 0, null, null);
    const fromIndex = await listSessionsFromIndex(env as unknown as WorkerEnv, {
      projectId,
      status: null,
      limit: 20,
      offset: 0,
      createdByUserId: null,
    });
    if (!('result' in fromIndex)) {
      throw new Error(`index read missed: ${fromIndex.missReason}`);
    }

    expect(fromIndex.result.sessions[0]?.attention).toEqual(fromDo.sessions[0]?.attention);
    expect((fromIndex.result.sessions[0]?.attention as { kind?: string } | null)?.kind).toBe(
      'needs_input'
    );
  });

  it('reflects markAgentCompleted in the index (writer previously had no sync hook)', async () => {
    // Regression for a rule-44 gap: markAgentCompleted mutates chat_sessions but
    // never scheduled a summary sync, so `agentCompletedAt` — and the derived
    // `isIdle` the sidebar renders — drifted in D1 until an unrelated write
    // happened to resync the project.
    await seed(projectId);
    const stub = getStub(projectId);
    await stub.ensureProjectId(projectId);
    const sessionId = await stub.createSession('workspace-1', 'Working');

    await stub.runSummarySyncForTest();
    let out = await listSessionsFromIndex(env as unknown as WorkerEnv, {
      projectId,
      status: null,
      limit: 20,
      offset: 0,
      createdByUserId: null,
    });
    if (!('result' in out)) throw new Error('expected a result');
    expect(out.result.sessions[0]?.isIdle).toBe(false);

    await stub.markAgentCompleted(sessionId);
    await stub.runSummarySyncForTest();

    out = await listSessionsFromIndex(env as unknown as WorkerEnv, {
      projectId,
      status: null,
      limit: 20,
      offset: 0,
      createdByUserId: null,
    });
    if (!('result' in out)) throw new Error('expected a result');
    expect(out.result.sessions[0]?.isIdle).toBe(true);
    expect(out.result.sessions[0]?.agentCompletedAt).not.toBeNull();
  });

  it('reflects linkSessionToWorkspace in the index (writer previously had no sync hook)', async () => {
    await seed(projectId);
    const stub = getStub(projectId);
    await stub.ensureProjectId(projectId);
    const sessionId = await stub.createSession(null, 'Unlinked');

    await stub.runSummarySyncForTest();
    await stub.linkSessionToWorkspace(sessionId, 'workspace-linked');
    await stub.runSummarySyncForTest();

    const out = await listSessionsFromIndex(env as unknown as WorkerEnv, {
      projectId,
      status: null,
      limit: 20,
      offset: 0,
      createdByUserId: null,
    });
    if (!('result' in out)) throw new Error('expected a result');
    expect(out.result.sessions[0]?.workspaceId).toBe('workspace-linked');
  });

  it('reflects a stopped session so the index cannot report it as still active', async () => {
    await seed(projectId);
    const stub = getStub(projectId);
    await stub.ensureProjectId(projectId);
    const sessionId = await stub.createSession('workspace-1', 'Ends soon');

    await stub.runSummarySyncForTest();
    await stub.stopSession(sessionId);
    await stub.runSummarySyncForTest();

    const out = await listSessionsFromIndex(env as unknown as WorkerEnv, {
      projectId,
      status: null,
      limit: 20,
      offset: 0,
      createdByUserId: null,
    });
    if (!('result' in out)) throw new Error('expected a result');
    expect(out.result.sessions[0]?.status).toBe('stopped');
    expect(out.result.sessions[0]?.isTerminated).toBe(true);
  });
});
