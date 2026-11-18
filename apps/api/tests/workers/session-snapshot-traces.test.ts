/**
 * Sleep/wake step traces through the real VM-agent callback route (rule 62): a callback JWT,
 * the real Worker routing and real D1. Covers the new agent's trace fields, an older agent's
 * phases-only body (rule 54), a mismatched chat identity, and the per-chat bound.
 */
import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import type { Env } from '../../src/env';
import { signCallbackToken } from '../../src/services/jwt';
import { listSessionSnapshotTraces } from '../../src/services/session-snapshot-traces';
import { seedNode, seedUser, seedWorkspace } from './helpers/seed-d1';

const USER_ID = 'user-traces';

async function seedRunningWorkspace(workspaceId: string, chatSessionId: string): Promise<void> {
  await seedUser(USER_ID);
  await seedNode(`node-${workspaceId}`, USER_ID);
  await seedWorkspace(workspaceId, `node-${workspaceId}`, USER_ID, {
    status: 'running',
    chatSessionId,
  });
}

async function postTimings(workspaceId: string, body: Record<string, unknown>): Promise<Response> {
  const token = await signCallbackToken(workspaceId, env as unknown as Env, {
    callbackGeneration: null,
  });
  return SELF.fetch(
    `https://api.test.example.com/api/workspaces/${workspaceId}/lifecycle-timings`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }
  );
}

describe('session snapshot step traces', () => {
  it('persists the failed step, its timings and a redacted error tail from a new agent', async () => {
    await seedRunningWorkspace('ws-trace-new', 'chat-trace-new');
    const secret = `ghp_${'B'.repeat(36)}`;
    const response = await postTimings('ws-trace-new', {
      operation: 'sleep',
      outcome: 'error',
      chatSessionId: 'chat-trace-new',
      failedPhase: 'home_capture',
      errorTail: `${'x'.repeat(2500)} tar: Cannot open: Permission denied token=${secret}`,
      phases: [
        { phase: 'prepare', durationMs: 40 },
        { phase: 'wip_capture', durationMs: 900 },
        { phase: 'home_capture', durationMs: 1200 },
      ],
    });
    expect(response.status, await response.clone().text()).toBe(200);

    const [trace] = await listSessionSnapshotTraces(env.DATABASE, 'chat-trace-new');
    expect(trace).toMatchObject({
      workspaceId: 'ws-trace-new',
      operation: 'sleep',
      outcome: 'error',
      failedPhase: 'home_capture',
      totalMs: 2140,
    });
    expect(trace!.phases.map((phase) => phase.phase)).toEqual([
      'prepare',
      'wip_capture',
      'home_capture',
    ]);
    expect(trace!.errorTail).toContain('Permission denied');
    expect(trace!.errorTail).not.toContain(secret);
    expect(trace!.errorTail!.length).toBeLessThanOrEqual(2000);
  });

  it('still records an older agent that sends only phase timings', async () => {
    await seedRunningWorkspace('ws-trace-old', 'chat-trace-old');
    const response = await postTimings('ws-trace-old', {
      operation: 'wake',
      phases: [
        { phase: 'metadata', durationMs: 12 },
        { phase: 'home_restore', durationMs: 300 },
      ],
    });
    expect(response.status).toBe(200);
    const [trace] = await listSessionSnapshotTraces(env.DATABASE, 'chat-trace-old');
    expect(trace).toMatchObject({
      operation: 'wake',
      outcome: 'success',
      failedPhase: null,
      errorTail: null,
      totalMs: 312,
    });
  });

  it('drops a trace whose claimed chat does not match the workspace, and ignores bad phase names', async () => {
    await seedRunningWorkspace('ws-trace-mismatch', 'chat-trace-real');
    const mismatch = await postTimings('ws-trace-mismatch', {
      operation: 'sleep',
      outcome: 'error',
      chatSessionId: 'chat-of-someone-else',
      phases: [{ phase: 'prepare', durationMs: 5 }],
    });
    expect(mismatch.status).toBe(200);
    expect(await listSessionSnapshotTraces(env.DATABASE, 'chat-of-someone-else')).toEqual([]);
    expect(await listSessionSnapshotTraces(env.DATABASE, 'chat-trace-real')).toEqual([]);

    // Control: the same workspace with its own chat id is recorded.
    await postTimings('ws-trace-mismatch', {
      operation: 'sleep',
      outcome: 'error',
      chatSessionId: 'chat-trace-real',
      failedPhase: '/etc/passwd',
      phases: [{ phase: 'prepare', durationMs: 5 }],
    });
    const [trace] = await listSessionSnapshotTraces(env.DATABASE, 'chat-trace-real');
    expect(trace).toMatchObject({ outcome: 'error', failedPhase: null });
  });

  it('keeps only the configured number of traces per chat', async () => {
    await seedRunningWorkspace('ws-trace-bound', 'chat-trace-bound');
    for (let index = 0; index < 12; index++) {
      await postTimings('ws-trace-bound', {
        operation: 'sleep',
        phases: [{ phase: 'prepare', durationMs: index }],
      });
    }
    const traces = await listSessionSnapshotTraces(env.DATABASE, 'chat-trace-bound', 50);
    expect(traces).toHaveLength(10);
    expect(traces[0]!.totalMs).toBe(11);
  });

  it('records nothing for provisioning summaries', async () => {
    await seedRunningWorkspace('ws-trace-provision', 'chat-trace-provision');
    await postTimings('ws-trace-provision', {
      operation: 'workspace',
      outcome: 'error',
      phases: [{ phase: 'devcontainer_up', durationMs: 5000 }],
    });
    expect(await listSessionSnapshotTraces(env.DATABASE, 'chat-trace-provision')).toEqual([]);
  });
});
