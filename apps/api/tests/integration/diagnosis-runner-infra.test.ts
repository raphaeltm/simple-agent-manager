import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
const runner = readFileSync(resolve(root, 'src/durable-objects/diagnosis-runner.ts'), 'utf8');
const routes = readFileSync(resolve(root, 'src/routes/admin.ts'), 'utf8');
const service = readFileSync(resolve(root, 'src/services/diagnosis-runner.ts'), 'utf8');
const policy = readFileSync(resolve(root, 'src/services/diagnosis-runner-policy.ts'), 'utf8');
const wrangler = readFileSync(resolve(root, 'wrangler.toml'), 'utf8');
const migration = readFileSync(resolve(root, 'src/db/migrations/0104_durable_debug_diagnosis_runs.sql'), 'utf8');

describe('DiagnosisRunner durable execution contract', () => {
  it('owns execution outside HTTP waitUntil and initializes the per-run DO before 202', () => {
    const startRoute = routes.slice(routes.indexOf("adminRoutes.post('/observability/diagnoses'"), routes.indexOf("adminRoutes.get('/observability/diagnosis-runs"));
    expect(startRoute).toContain('await startDiagnosisRunner(c.env, run.id)');
    expect(startRoute).not.toContain('waitUntil');
    expect(service).toContain('idFromName(runId)');
    expect(runner).toContain('await tx.setAlarm(Date.now())');
  });

  it('dispatches exactly one model turn or one tool call from each alarm', () => {
    const alarm = runner.slice(runner.indexOf('async alarm()'), runner.indexOf('private async runModelStep'));
    expect(alarm).toContain("if (state.currentStep === 'model') await this.runModelStep");
    expect(alarm).toContain('else await this.runToolStep');
    const tool = runner.slice(runner.indexOf('private async runToolStep'), runner.indexOf('private async checkpointAndSchedule'));
    expect(tool).toContain('const call = state.pendingTools[0]');
    expect(tool).toContain('state.pendingTools.shift()');
    expect(tool).not.toContain('for (');
  });

  it('checkpoints idempotency, heartbeat, events, cancellation, deadlines, and classified retry before rescheduling', () => {
    expect(runner).toContain('completedStepKeys.includes(stepKey)');
    expect(runner).toContain('cancel_requested_at');
    expect(runner).toContain('run.deadline_at ? Date.parse(run.deadline_at)');
    expect(runner).toContain('classifyDiagnosisFailure(error)');
    expect(runner).toContain('await this.ctx.storage.put');
    expect(runner).toContain('await this.ctx.storage.setAlarm');
    expect(migration).toContain('UNIQUE(run_id, step_key)');
    expect(migration).toContain('debug_diagnosis_run_events');
  });

  it('binds and migrates a dedicated SQLite Durable Object and reconciles bounded stale rows', () => {
    expect(wrangler).toContain('name = "DIAGNOSIS_RUNNER"');
    expect(wrangler).toContain('new_sqlite_classes = ["DiagnosisRunner"]');
    expect(service).toContain("LIMIT 50");
    expect(service).toContain("status IN ('queued','running')");
    expect(service).toContain('startDiagnosisRunner(env, row.id)');
  });

  it('stores only redacted bounded previews and sanitized failures', () => {
    expect(runner).toContain('redactSensitiveData');
    expect(policy).toContain('.slice(0, 500)');
    expect(runner).toContain('.slice(0, 300)');
    expect(runner).toContain('.slice(0, 1000)');
    expect(runner).not.toContain('chain-of-thought');
    expect(routes).not.toMatch(/github.*issue/i);
  });
});
