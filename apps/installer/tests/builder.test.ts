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
  expect((options as unknown as { instance: string }).instance).toBe('standard-4');
  // The restore reads shared source from the same state bucket the engine derives.
  expect(options.env.SAM_BUILD_CACHE_BUCKET).toBe('s123abc-pulumi-state-staging');
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
it('publishes only a well-formed pinned-runtime receipt', async () => {
  const h = harness();
  await h.call('/start', h.job);
  const receipt = {
    version: 2,
    source: 'publisher',
    archiveSHA256: 'a'.repeat(64),
    archiveBytes: 136245837,
    installerSHA256: 'b'.repeat(64),
  };
  h.setProgress({ state: 'running', runtimeTrust: { ...receipt, extra: 'private-detail' } });
  await h.call('/status');
  const trust = h.env.BUILDER_ARTIFACTS.put.mock.calls.find((args) =>
    String((args as unknown as [string])[0]).endsWith('/codex-trust.json')
  ) as unknown as [string, string];
  expect(JSON.parse(trust[1])).toEqual(receipt);
  h.env.BUILDER_ARTIFACTS.put.mock.calls.length = 0;
  // The retired in-account build receipt and malformed digests are not published.
  for (const runtimeTrust of [
    { ...receipt, version: 1 },
    { ...receipt, source: 'installation' },
    { ...receipt, archiveSHA256: 'not-a-digest' },
  ]) {
    h.setProgress({ state: 'running', runtimeTrust });
    await h.call('/status');
  }
  expect(
    h.env.BUILDER_ARTIFACTS.put.mock.calls.some((args) =>
      String((args as unknown as [string])[0]).endsWith('/codex-trust.json')
    )
  ).toBe(false);
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
// The first real full install failed in the container's source step with no
// recorded reason (staging, 2026-11-06). The failing step must reach the owner.
it('records which setup step failed and drops unsafe failure text', async () => {
  const h = harness();
  await h.call('/start', h.job);
  h.setProgress({
    state: 'failed',
    failure: { step: 'source', reason: 'Source storage request failed (HTTP 403)' },
  });
  const status = await (await h.call('/status')).json();
  expect(status.status).toBe('failed');
  expect(status.failure).toEqual({
    step: 'source',
    reason: 'Source storage request failed (HTTP 403)',
  });
  const published = h.env.BUILDER_ARTIFACTS.put.mock.calls.at(-1) as unknown as [string, string];
  expect(JSON.parse(published[1]).failure.step).toBe('source');

  const unsafe = harness();
  await unsafe.call('/start', unsafe.job);
  unsafe.setProgress({
    state: 'failed',
    failure: {
      step: 'source',
      reason: 'Command failed: curl https://acct.r2.cloudflarestorage.com/x',
      code: 63,
    },
  });
  const sanitized = (await (await unsafe.call('/status')).json()).failure;
  expect(sanitized).toEqual({ step: 'source', code: 63 });
});
it('supervisor reports only fixed-string errors or an exit code', () => {
  const supervisor = JSON.parse(
    /const BUILDER_SUPERVISOR=(".*?");\n/s.exec(builderSource)![1]!
  ) as string;
  const line = /const reason = (.*?);\n/.exec(supervisor)![1]!;
  const reason = new Function(`return ${line}`)() as (error: unknown) => string;
  expect(reason(new Error('Source storage request failed (HTTP 403)'))).toBe(
    'Source storage request failed (HTTP 403)'
  );
  const curl = Object.assign(
    new Error('Command failed: curl --config /x https://acct.example/key'),
    {
      status: 63,
    }
  );
  expect(reason(curl)).toBe('exit 63');
  expect(reason({})).toBe('unexpected error');
});
it('scrubs secret environment values from the engine output tail', () => {
  const supervisor = JSON.parse(
    /const BUILDER_SUPERVISOR=(".*?");\n/s.exec(builderSource)![1]!
  ) as string;
  const pick = (name: string) => new RegExp(`(const ${name} = .*?;)\\n`).exec(supervisor)![1]!;
  const make = new Function(
    'process',
    `${pick('secrets')}\n${pick('tail')}\n${pick('keep')}\nreturn { keep, tail };`
  ) as (process: { env: Record<string, string> }) => {
    keep: (line: string) => void;
    tail: string[];
  };
  const { keep, tail } = make({
    env: {
      CF_API_TOKEN: 'cf-token-private-value',
      R2_SECRET_ACCESS_KEY: 'r2-secret-private',
      CF_ACCOUNT_ID: 'a'.repeat(32),
    },
  });
  keep('pulumi error: authorization cf-token-private-value rejected for account ' + 'a'.repeat(32));
  keep('upload with r2-secret-private failed');
  for (let index = 0; index < 50; index++) keep(`line ${index}`);
  expect(tail).toHaveLength(40);
  const early = make({ env: { CF_API_TOKEN: 'cf-token-private-value' } });
  early.keep('using cf-token-private-value now');
  expect(early.tail).toEqual(['using [redacted] now']);
});
it('keeps a bounded engine output tail in the failure report', async () => {
  const h = harness();
  await h.call('/start', h.job);
  h.setProgress({
    state: 'failed',
    failure: {
      step: 'bootstrap',
      code: 1,
      tail: ['error: route already exists', 7, 'x'.repeat(900)],
    },
  });
  const failure = (await (await h.call('/status')).json()).failure;
  expect(failure.code).toBe(1);
  expect(failure.tail).toEqual(['error: route already exists', 'x'.repeat(400)]);
});
