import { afterEach, expect, it, vi } from 'vitest';

import { builderSource } from '../src/builder';
import { supportedProtocol, supportedSourceFetch } from './source-policy-fixture';
afterEach(() => vi.unstubAllGlobals());
function harness() {
  vi.stubGlobal('fetch', vi.fn(supportedSourceFetch));
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
    workersDev: { action: 'preserve', subdomain: 'account-address' },
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

it.each(['behind', 'diverged'])(
  'rejects a %s update before starting or destroying paid compute',
  async (status) => {
    const h = harness();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({ status, ahead_by: status === 'behind' ? 0 : 2, behind_by: 1 })
      )
    );
    const response = await h.call('/start', { ...h.job, previousSourceCommit: 'e'.repeat(40) });
    expect(response.status).toBe(409);
    expect(h.container.start).not.toHaveBeenCalled();
    expect(h.container.destroy).not.toHaveBeenCalled();
    expect(h.values.has('job')).toBe(false);
  }
);

it.each(['manifest', 'protocol', 'capability', 'engine'])(
  'requires compatible source %s before initial paid startup',
  async (missing) => {
    const h = harness();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (missing === 'manifest' && url.endsWith('/installer-protocol.json'))
          return new Response(null, { status: 404 });
        if (url.endsWith('/installer-protocol.json'))
          return Response.json({
            ...supportedProtocol,
            ...(missing === 'protocol'
              ? { protocolVersion: 999 }
              : missing === 'capability'
                ? { capabilities: [] }
                : {}),
          });
        if (missing === 'engine' && url.endsWith('/installer-engine-cli.ts'))
          return new Response(null, { status: 404 });
        return supportedSourceFetch(input, init);
      })
    );
    expect((await h.call('/start', h.job)).status).toBe(409);
    expect(h.container.start).not.toHaveBeenCalled();
    expect(h.container.destroy).not.toHaveBeenCalled();
  }
);

it('resumes only the exact validated source proof without requiring upstream availability', async () => {
  const h = harness();
  expect((await h.call('/start', h.job)).status).toBe(202);
  const job = h.values.get('job') as {
    status: string;
    sourceValidation: { sourceCommit: string; protocolVersion: number };
  };
  expect(job.sourceValidation).toEqual({ sourceCommit: h.job.sourceCommit, protocolVersion: 1 });
  job.status = 'failed';
  const unavailable = vi.fn(async () => {
    throw new Error('upstream unavailable');
  });
  vi.stubGlobal('fetch', unavailable);
  expect((await h.call('/resume', { jobId: h.job.jobId })).status).toBe(202);
  expect(unavailable).not.toHaveBeenCalled();
  const resumed = h.values.get('job') as typeof job;
  resumed.status = 'failed';
  resumed.sourceValidation.sourceCommit = 'f'.repeat(40);
  expect((await h.call('/resume', { jobId: h.job.jobId })).status).toBe(409);
  expect(h.container.start).toHaveBeenCalledTimes(2);
});

it('accepts one forward commit when compare page two has no commits or file patches', async () => {
  const h = harness();
  const upstream = vi.fn(supportedSourceFetch);
  vi.stubGlobal('fetch', upstream);
  const base = 'e'.repeat(40);
  expect((await h.call('/start', { ...h.job, previousSourceCommit: base })).status).toBe(202);
  const comparison = upstream.mock.calls.find(([input]) => String(input).includes('/compare/'));
  const url = new URL(String(comparison![0]));
  expect(url.searchParams.get('per_page')).toBe('1');
  expect(url.searchParams.get('page')).toBe('2');
  expect((h.values.get('job') as { sourceValidation: unknown }).sourceValidation).toEqual({
    protocolVersion: 1,
    sourceCommit: h.job.sourceCommit,
    previousSourceCommit: base,
  });
});

it('persists verified canonical source identity and binds offline resume to that manifest', async () => {
  const h = harness();
  await h.call('/start', h.job);
  const sourceIdentity = {
    version: 1,
    commit: h.job.sourceCommit,
    tree: 'a'.repeat(40),
    bundleSHA256: 'e'.repeat(64),
    bundleBytes: 12345,
  };
  h.setProgress({ state: 'running', sourceIdentity });
  await h.builder.alarm();
  expect((h.values.get('job') as { sourceIdentity: unknown }).sourceIdentity).toEqual(
    sourceIdentity
  );
  await h.call('/cancel', {});
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('offline');
    })
  );
  expect((await h.call('/resume', { jobId: h.job.jobId })).status).toBe(202);
  const options = h.container.start.mock.calls.at(-1)![0] as unknown as {
    env: Record<string, string>;
  };
  expect(JSON.parse(options.env.SAM_SOURCE_IDENTITY)).toEqual(sourceIdentity);
  h.setProgress({ state: 'running', sourceIdentity: { ...sourceIdentity, tree: 'f'.repeat(40) } });
  await h.builder.alarm();
  expect((h.values.get('job') as { status: string }).status).toBe('failed');
});
