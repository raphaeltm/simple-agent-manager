import { expect, it, vi } from 'vitest';

import { builderSource } from '../src/builder';
function harness() {
  const values = new Map<string, unknown>();
  let alarm: number | undefined;
  let info: unknown = null;
  let progress: unknown = { state: 'running' };
  const storage = {
    get: vi.fn(async (key: string) => values.get(key)),
    put: vi.fn(async (key: string, value: unknown) => {
      values.set(key, structuredClone(value));
    }),
    setAlarm: vi.fn(async (value: number) => {
      alarm = value;
    }),
    deleteAlarm: vi.fn(async () => {
      alarm = undefined;
    }),
  };
  const container = {
    start: vi.fn((options: { labels: unknown }) => {
      info = { labels: options.labels };
    }),
    destroy: vi.fn(async () => {
      info = null;
    }),
    inspect: vi.fn(async () => info),
    getTcpPort: vi.fn(() => ({ fetch: vi.fn(async () => Response.json(progress)) })),
  };
  const env = {
    BUILDER_CONTROL_SECRET: 'private-control',
    CF_ACCOUNT_ID: 'a'.repeat(32),
    CF_API_TOKEN: 'deployment-secret',
    CF_RUNTIME_API_TOKEN: 'runtime-secret',
    R2_ACCESS_KEY_ID: 'r2-key',
    R2_SECRET_ACCESS_KEY: 'r2-secret',
    PULUMI_CONFIG_PASSPHRASE: 'passphrase',
    SAM_ARTIFACTS_BUCKET: 'sam-build-test',
    BUILDER_ARTIFACTS: { put: vi.fn(async () => {}) },
  };
  const Constructor = new Function(
    builderSource.replace('export class InstallationBuilder', 'return class InstallationBuilder')
  )();
  const ctx = { storage, container };
  const builder = new Constructor(ctx, env);
  const job = {
    jobId: 'b'.repeat(32),
    sourceCommit: 'c'.repeat(40),
    accountId: env.CF_ACCOUNT_ID,
    zoneId: 'd'.repeat(32),
    zoneName: 'example.com',
    baseDomain: 'sam.example.com',
    environment: 'staging',
    prefix: 's123abc',
    ownerEmail: 'person@example.com',
  };
  const call = (path: string, body?: unknown, secret = env.BUILDER_CONTROL_SECRET) =>
    builder.fetch(
      new Request(`https://builder${path}`, {
        method: body ? 'POST' : 'GET',
        headers: { Authorization: `Bearer ${secret}` },
        ...(body ? { body: JSON.stringify(body) } : {}),
      })
    );
  return {
    builder,
    Constructor,
    ctx,
    env,
    job,
    call,
    values,
    storage,
    container,
    setProgress: (value: unknown) => {
      progress = value;
    },
    getAlarm: () => alarm,
  };
}
it('requires internal authority, validates immutable jobs, and starts only one managed-image process', async () => {
  const h = harness();
  expect((await h.call('/start', h.job, 'wrong')).status).toBe(403);
  expect((await h.call('/start', { ...h.job, sourceCommit: 'main' })).status).toBe(400);
  expect((await h.call('/start', { ...h.job, accountId: 'f'.repeat(32) })).status).toBe(400);
  expect((await h.call('/start', h.job)).status).toBe(202);
  expect((await h.call('/start', h.job)).status).toBe(409);
  expect(h.container.start).toHaveBeenCalledTimes(1);
  const options = h.container.start.mock.calls[0][0] as unknown as {
    image: string;
    entrypoint: string[];
    env: Record<string, string>;
  };
  expect(options.image).toBe('cloudflare/debian-trixie');
  expect(options.entrypoint.slice(0, 2)).toEqual(['node', '-e']);
  expect(options.env.CF_RUNTIME_API_TOKEN).toBe('runtime-secret');
  expect(options.env).not.toHaveProperty('BUILDER_CONTROL_SECRET');
  expect(JSON.stringify(await (await h.call('/status')).json())).not.toContain('secret');
  expect(h.getAlarm()).toBeTypeOf('number');
});
it('reconciles an existing process after DO restart and destroys all compute on deadline', async () => {
  const h = harness();
  await h.call('/start', h.job);
  const checkpoint = {
    schemaVersion: 1,
    fingerprint: 'e'.repeat(64),
    completed: ['preflight'],
    status: 'running',
    activePhase: 'codex-source-build',
  };
  h.setProgress({ state: 'running', checkpoint });
  const restarted = new h.Constructor(h.ctx, h.env);
  await restarted.alarm();
  expect(h.container.start).toHaveBeenCalledTimes(1);
  expect((h.values.get('job') as { checkpoint: unknown }).checkpoint).toEqual(checkpoint);
  const record = h.values.get('job') as { deadline: number };
  record.deadline = Date.now() - 1;
  h.values.set('job', record);
  await restarted.alarm();
  expect(h.container.destroy).toHaveBeenLastCalledWith('SAM builder timed_out');
  expect((h.values.get('job') as { status: string }).status).toBe('timed_out');
  expect(h.getAlarm()).toBeUndefined();
});
it('keeps setup result private and stops a completed container', async () => {
  const h = harness();
  await h.call('/start', h.job);
  h.setProgress({
    state: 'completed',
    result: { setupToken: 'private-setup-token-value', appUrl: 'https://app.sam.example.com' },
  });
  const status = await (await h.call('/status')).json();
  expect(JSON.stringify(status)).not.toContain('private-setup');
  expect((await (await h.call('/result')).json()).setupToken).toBe('private-setup-token-value');
  for (const args of h.env.BUILDER_ARTIFACTS.put.mock.calls)
    expect(JSON.stringify(args)).not.toContain('private-setup');
  expect(h.container.destroy).toHaveBeenLastCalledWith('SAM builder completed');
});
it('cancels and explicitly resumes a job after destroying uncertain old processes', async () => {
  const h = harness();
  await h.call('/start', h.job);
  await h.call('/cancel', {});
  expect(h.container.destroy).toHaveBeenLastCalledWith('SAM builder cancelled');
  expect((await h.call('/resume', { jobId: h.job.jobId })).status).toBe(202);
  expect(h.container.start).toHaveBeenCalledTimes(2);
  expect(h.container.destroy).toHaveBeenLastCalledWith('SAM explicit resume');
});
it('retains terminal stop intent and retries whole-container stop after transport failure', async () => {
  const h = harness();
  await h.call('/start', h.job);
  h.container.destroy.mockRejectedValueOnce(new Error('provider failure'));
  expect((await h.call('/cancel', {})).status).toBe(503);
  expect((h.values.get('job') as { stopping: boolean }).stopping).toBe(true);
  expect(h.getAlarm()).toBeTypeOf('number');
  await h.builder.alarm();
  expect((h.values.get('job') as { status: string; stopping?: boolean }).status).toBe('cancelled');
  expect((h.values.get('job') as { stopping?: boolean }).stopping).toBeUndefined();
  expect(h.getAlarm()).toBeUndefined();
});
