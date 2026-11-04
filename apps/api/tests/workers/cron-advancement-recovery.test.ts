/** Exercise the actual sweep and admission SQL on workerd D1 without starting compute. */
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { runCronTriggerSweep } from '../../src/scheduled/cron-triggers';
import {
  seedInstallation,
  seedProject,
  seedTrigger,
  seedTriggerExecution,
  seedUser,
} from './helpers/seed-d1';

const USER = 'cron-recovery-user';
const PROJECT = 'cron-recovery-project';
const DUE = '2026-01-01T00:00:00.000Z';

describe('cron advancement isolation on real D1', () => {
  it('continues past a failed update and recovers the same skipped occurrence next sweep', async () => {
    await seedUser(USER);
    await seedInstallation('cron-recovery-installation', USER);
    await seedProject(PROJECT, USER, 'cron-recovery-installation');
    for (const id of ['cron-recovery-a', 'cron-recovery-b']) {
      await seedTrigger(id, PROJECT, USER, {
        sourceType: 'cron',
        nextFireAt: DUE,
        cronExpression: '0 * * * *',
        skipIfRunning: true,
      });
      await seedTriggerExecution(`busy-${id}`, id, PROJECT, { status: 'running' });
    }
    await env.DATABASE
      .exec(`CREATE TRIGGER cron_test_fail_advance BEFORE UPDATE OF next_fire_at ON triggers
      WHEN OLD.id = 'cron-recovery-a' BEGIN SELECT RAISE(ABORT, 'SQLITE_BUSY: injected test failure'); END`);
    try {
      await expect(runCronTriggerSweep(env)).resolves.toMatchObject({
        checked: 2,
        failed: 1,
        skipped: 1,
      });
      const before = await env.DATABASE.prepare(
        "SELECT id, sequence_number FROM trigger_executions WHERE trigger_id=? AND status='skipped'"
      )
        .bind('cron-recovery-a')
        .first();
      expect(before).not.toBeNull();
      await env.DATABASE.exec('DROP TRIGGER cron_test_fail_advance');
      // With the original busy run complete, a duplicate admission would submit a real task.
      await env.DATABASE.prepare("UPDATE trigger_executions SET status='completed' WHERE id=?")
        .bind('busy-cron-recovery-a')
        .run();
      await expect(runCronTriggerSweep(env)).resolves.toMatchObject({
        checked: 1,
        failed: 0,
        skipped: 1,
      });
      const after = await env.DATABASE.prepare(
        "SELECT id, sequence_number FROM trigger_executions WHERE trigger_id=? AND status='skipped'"
      )
        .bind('cron-recovery-a')
        .all();
      expect(after.results).toEqual([before]);
      expect(
        await env.DATABASE.prepare('SELECT next_execution_sequence FROM triggers WHERE id=?')
          .bind('cron-recovery-a')
          .first('next_execution_sequence')
      ).toBe(2);
    } finally {
      await env.DATABASE.exec('DROP TRIGGER IF EXISTS cron_test_fail_advance');
    }
  });
});
