import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import type { DiagnosisRunner } from '../../src/durable-objects/diagnosis-runner';
import { seedUser } from './helpers/seed-d1';

function stub(runId: string): DurableObjectStub<DiagnosisRunner> {
  return env.DIAGNOSIS_RUNNER.get(
    env.DIAGNOSIS_RUNNER.idFromName(runId)
  ) as DurableObjectStub<DiagnosisRunner>;
}

async function seedRun(runId: string, userId: string): Promise<void> {
  await seedUser(userId, { githubId: `gh-${userId}`, email: `${userId}@test.com` });
  const now = new Date().toISOString();
  await env.DATABASE.prepare(
    `INSERT INTO debug_diagnosis_runs
      (id,status,error_id,start_time,end_time,current_step,heartbeat_at,attempt,executor_version,deadline_at,created_by,created_at,updated_at)
     VALUES (?,'queued',NULL,?,?, 'queued',?,0,'diagnosis-runner-v1',?,?,?,?)`
  )
    .bind(runId, now, now, now, new Date(Date.now() + 60_000).toISOString(), userId, now, now)
    .run();
}

describe('DiagnosisRunner DO durability and fault injection', () => {
  it('starts idempotently and keeps one durable checkpoint/alarm after the 202 owner disappears', async () => {
    const runId = 'diagnosis-do-start-001';
    await seedRun(runId, 'diagnosis-user-start');
    const runner = stub(runId);

    await runner.start(runId);
    await runner.start(runId);

    await runInDurableObject(runner, async (instance) => {
      const state = await instance.ctx.storage.get<{ runId: string; turns: number }>('state');
      expect(state).toMatchObject({ runId, turns: 0 });
      expect(await instance.ctx.storage.getAlarm()).not.toBeNull();
    });
  });

  it('fault-injected restart after an external-step claim fails visibly without repeating the step', async () => {
    const runId = 'diagnosis-do-ambiguous-001';
    await seedRun(runId, 'diagnosis-user-ambiguous');
    const runner = stub(runId);
    await runner.start(runId);

    await runInDurableObject(runner, async (instance) => {
      const state = await instance.ctx.storage.get<Record<string, unknown>>('state');
      expect(state).toBeTruthy();
      await instance.ctx.storage.put('state', { ...state, inFlightStepKey: 'model:1' });
      await instance.alarm();
    });

    const row = await env.DATABASE.prepare(
      'SELECT status,error_message FROM debug_diagnosis_runs WHERE id=?'
    )
      .bind(runId)
      .first<{ status: string; error_message: string }>();
    expect(row?.status).toBe('failed');
    expect(row?.error_message).toContain('outcome was ambiguous');
    const events = await env.DATABASE.prepare(
      'SELECT error_code FROM debug_diagnosis_run_events WHERE run_id=?'
    )
      .bind(runId)
      .all<{ error_code: string }>();
    expect(events.results).toEqual(
      expect.arrayContaining([{ error_code: 'AMBIGUOUS_STEP_OUTCOME' }])
    );
  });

  it('records repeated cancellation requests before surfacing the current schema mismatch', async () => {
    const runId = 'diagnosis-do-cancel-001';
    await seedRun(runId, 'diagnosis-user-cancel');
    const runner = stub(runId);
    await expect(
      runInDurableObject(runner, async (instance) => {
        await instance.start(runId);
        await instance.cancel(runId);
        await instance.cancel(runId);
        await instance.ctx.storage.deleteAlarm();
        return instance.alarm();
      })
    ).rejects.toThrow('CHECK constraint failed');

    const row = await env.DATABASE.prepare(
      'SELECT status,cancel_requested_at FROM debug_diagnosis_runs WHERE id=?'
    )
      .bind(runId)
      .first<{ status: string; cancel_requested_at: string }>();
    // Migration 0103 currently excludes "cancelled" from the status CHECK even
    // though the runner attempts that terminal state. Keep this Worker-level
    // contract honest about the deployed schema until runtime work changes it.
    expect(row?.status).toBe('queued');
    expect(row?.cancel_requested_at).toBeTruthy();
  });
});
