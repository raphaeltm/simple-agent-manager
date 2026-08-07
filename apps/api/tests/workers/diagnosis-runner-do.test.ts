import { applyD1Migrations, env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';

import type { DiagnosisRunner } from '../../src/durable-objects/diagnosis-runner';
import { listDiagnosisEvents, reconcileDiagnosisRuns } from '../../src/services/diagnosis-runner';
import { seedUser } from './helpers/seed-d1';

beforeAll(async () => {
  const migrations = (
    env as unknown as { TEST_PRIMARY_MIGRATIONS?: Parameters<typeof applyD1Migrations>[1] }
  ).TEST_PRIMARY_MIGRATIONS;
  // The focused debugging config supplies migrations as a binding. The full
  // Worker corpus applies them once from its shared setup file instead.
  if (migrations) await applyD1Migrations(env.DATABASE, migrations);
});

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

async function waitForModelAwait(runId: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const started = await env.DATABASE.prepare(
      "SELECT 1 AS started FROM debug_diagnosis_run_events WHERE run_id=? AND step_key='model:1:started'"
    )
      .bind(runId)
      .first<{ started: number }>();
    if (started) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Diagnosis runner did not enter the model await');
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
      'SELECT run_status,error_message FROM debug_diagnosis_runs WHERE id=?'
    )
      .bind(runId)
      .first<{ run_status: string; error_message: string }>();
    expect(row?.run_status).toBe('failed');
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
    await runner.start(runId);
    await runner.cancel(runId);
    await runner.cancel(runId);
    await runInDurableObject(runner, async (instance) => instance.alarm());
    await runInDurableObject(runner, async (instance) => instance.alarm());

    const row = await env.DATABASE.prepare(
      'SELECT status,run_status,cancel_requested_at FROM debug_diagnosis_runs WHERE id=?'
    )
      .bind(runId)
      .first<{ status: string; run_status: string; cancel_requested_at: string }>();
    expect(row?.status).toBe('failed');
    expect(row?.run_status).toBe('cancelled');
    expect(row?.cancel_requested_at).toBeTruthy();
    const terminalEvents = await env.DATABASE.prepare(
      "SELECT COUNT(*) AS count FROM debug_diagnosis_run_events WHERE run_id=? AND step_key='terminal:cancelled'"
    )
      .bind(runId)
      .first<{ count: number }>();
    expect(terminalEvents?.count).toBe(1);
  });

  it('keeps cancellation terminal when it commits during the real model await', async () => {
    const runId = 'diagnosis-do-cancel-race-001';
    await seedRun(runId, 'diagnosis-user-cancel-race');
    const runner = stub(runId);
    await runner.start(runId);

    const alarm = runDurableObjectAlarm(runner);
    await waitForModelAwait(runId);
    await runner.cancel(runId);
    expect(
      await env.DATABASE.prepare('SELECT cancel_requested_at FROM debug_diagnosis_runs WHERE id=?')
        .bind(runId)
        .first<{ cancel_requested_at: string | null }>()
    ).toMatchObject({ cancel_requested_at: expect.any(String) });
    await alarm;
    await runInDurableObject(runner, async (instance) => instance.alarm());
    await runInDurableObject(runner, async (instance) => instance.alarm());

    const row = await env.DATABASE.prepare(
      'SELECT run_status,diagnosis_id FROM debug_diagnosis_runs WHERE id=?'
    )
      .bind(runId)
      .first<{ run_status: string; diagnosis_id: string | null }>();
    expect(row).toEqual({ run_status: 'cancelled', diagnosis_id: null });
    expect(
      await env.DATABASE.prepare('SELECT COUNT(*) AS count FROM debug_diagnoses WHERE created_by=?')
        .bind('diagnosis-user-cancel-race')
        .first<{ count: number }>()
    ).toEqual({ count: 0 });
    expect(
      await env.DATABASE.prepare(
        "SELECT step_key,COUNT(*) AS count FROM debug_diagnosis_run_events WHERE run_id=? AND step_key IN ('completed','terminal:cancelled') GROUP BY step_key"
      )
        .bind(runId)
        .all<{ step_key: string; count: number }>()
    ).toMatchObject({ results: [{ step_key: 'terminal:cancelled', count: 1 }] });
  });

  it('keeps deadline reconciliation terminal when it commits during the real model await', async () => {
    const runId = 'diagnosis-do-deadline-race-001';
    await seedRun(runId, 'diagnosis-user-deadline-race');
    const runner = stub(runId);
    await runner.start(runId);

    const alarm = runDurableObjectAlarm(runner);
    await waitForModelAwait(runId);
    await env.DATABASE.prepare(
      "UPDATE debug_diagnosis_runs SET deadline_at='2020-01-01T00:00:00.000Z',heartbeat_at='2020-01-01T00:00:00.000Z' WHERE id=?"
    )
      .bind(runId)
      .run();
    expect(await reconcileDiagnosisRuns(env)).toMatchObject({ terminalized: 1 });
    await alarm;
    await runInDurableObject(runner, async (instance) => instance.alarm());
    await runInDurableObject(runner, async (instance) => instance.alarm());

    const row = await env.DATABASE.prepare(
      'SELECT run_status,diagnosis_id FROM debug_diagnosis_runs WHERE id=?'
    )
      .bind(runId)
      .first<{ run_status: string; diagnosis_id: string | null }>();
    expect(row).toEqual({ run_status: 'failed', diagnosis_id: null });
    const terminalEvents = await env.DATABASE.prepare(
      "SELECT COUNT(*) AS count FROM debug_diagnosis_run_events WHERE run_id=? AND step_key='terminal:failed'"
    )
      .bind(runId)
      .first<{ count: number }>();
    expect(terminalEvents?.count).toBe(1);
    expect(
      await env.DATABASE.prepare('SELECT COUNT(*) AS count FROM debug_diagnoses WHERE created_by=?')
        .bind('diagnosis-user-deadline-race')
        .first<{ count: number }>()
    ).toEqual({ count: 0 });
  });

  it('returns a cursor only when another event page exists and preserves all events', async () => {
    const runId = 'diagnosis-do-pagination-001';
    await seedRun(runId, 'diagnosis-user-pagination');
    const statements: D1PreparedStatement[] = [];
    for (let sequence = 1; sequence <= 205; sequence++) {
      statements.push(
        env.DATABASE.prepare(
          `INSERT INTO debug_diagnosis_run_events
            (id,run_id,sequence,step_key,event_type,status,retry_attempt,created_at)
           VALUES (?,?,?,?,?,?,0,?)`
        ).bind(
          `pagination-event-${sequence}`,
          runId,
          sequence,
          `pagination-step-${sequence}`,
          'evidence',
          'succeeded',
          new Date().toISOString()
        )
      );
    }
    for (let offset = 0; offset < statements.length; offset += 50) {
      await env.DATABASE.batch(statements.slice(offset, offset + 50));
    }

    const first = await listDiagnosisEvents(env, runId, 0, 100);
    const second = await listDiagnosisEvents(env, runId, first.nextCursor ?? 0, 100);
    const third = await listDiagnosisEvents(env, runId, second.nextCursor ?? 0, 100);

    expect(first.events).toHaveLength(100);
    expect(first.nextCursor).toBe(100);
    expect(second.events).toHaveLength(100);
    expect(second.nextCursor).toBe(200);
    expect(third.events).toHaveLength(5);
    expect(third.nextCursor).toBeNull();
    expect(
      [...first.events, ...second.events, ...third.events].map((event) => event.sequence)
    ).toEqual(Array.from({ length: 205 }, (_, index) => index + 1));
  });
});
