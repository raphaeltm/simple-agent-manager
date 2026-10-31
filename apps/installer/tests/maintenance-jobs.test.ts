import { afterEach, describe, expect, it, vi } from 'vitest';

import { maintenanceSource } from '../src/maintenance';
import { digest } from '../src/security';
import { supportedProtocol, supportedSourceFetch } from './source-policy-fixture';

const Coordinator = new Function(
  maintenanceSource
    .replace('export class MaintenanceCoordinator', 'class MaintenanceCoordinator')
    .replace('export default', 'const worker =') + '\nreturn MaintenanceCoordinator;'
)() as new (
  state: unknown,
  env: Record<string, unknown>
) => { fetch(request: Request): Promise<Response> };
const target = 'https://owner.example.workers.dev',
  installer = 'https://install.example.com';
const original = 'a'.repeat(40),
  updated = 'b'.repeat(40);
async function fixture() {
  const values = new Map<string, unknown>();
  const storage = {
    async get(key: string) {
      return structuredClone(values.get(key));
    },
    async put(key: string, value: unknown) {
      values.set(key, structuredClone(value));
    },
    async delete(key: string) {
      return values.delete(key);
    },
    async transaction<T>(action: (s: typeof storage) => Promise<T>): Promise<T> {
      return action(storage);
    },
  };
  let job: Record<string, unknown> = { status: 'idle' };
  let dropStartResponse = false;
  const calls: Array<{ path: string; body?: Record<string, unknown> }> = [];
  const builderFetch = vi.fn(async (request: Request) => {
    const path = new URL(request.url).pathname;
    const body =
      request.method === 'POST' ? ((await request.json()) as Record<string, unknown>) : undefined;
    calls.push({ path, body });
    if (path === '/status') return Response.json(job);
    if (path === '/result')
      return Response.json({
        appUrl: 'https://app.sam.example.com',
        setupToken: 'private-setup-token-for-owner',
      });
    if (path === '/start')
      job = { status: 'running', jobId: body!.jobId, sourceCommit: body!.sourceCommit };
    if (path === '/start' && dropStartResponse) {
      dropStartResponse = false;
      return Response.json({ error: 'lost response after acceptance' }, { status: 503 });
    }
    return Response.json({ ok: true });
  });
  const env: Record<string, unknown> = {
    INSTALLER_ORIGIN: installer,
    OWNER_KEY_HASH: await digest('claim-key'),
    CLAIM_EXPIRES: String(Date.now() + 60000),
    CF_ACCOUNT_ID: 'c'.repeat(32),
    BUILDER_CONTROL_SECRET: 'builder-control',
    INSTALLATION_CONFIG: JSON.stringify({
      accountId: 'c'.repeat(32),
      zoneId: 'd'.repeat(32),
      zoneName: 'example.com',
      baseDomain: 'sam.example.com',
      ownerEmail: 'owner@example.com',
      sourceCommit: original,
    }),
    BUILDER: { idFromName: () => 'installation', get: () => ({ fetch: builderFetch }) },
  };
  const service = new Coordinator({ storage }, env);
  const claim = await service.fetch(
    new Request(target + '/claim', {
      method: 'POST',
      headers: { Origin: installer },
      body: new URLSearchParams({ key: 'claim-key' }),
    })
  );
  const cookie = claim.headers.get('Set-Cookie')!.split(';')[0]!;
  const claimHtml = await claim.text();
  const recovery = /<code>([a-f0-9]{64})<\/code>/.exec(claimHtml)![1]!;
  const request = (
    path: string,
    body?: Record<string, string>,
    authenticated = true,
    origin = target
  ) =>
    service.fetch(
      new Request(target + path, {
        method: body ? 'POST' : 'GET',
        headers: {
          ...(authenticated ? { Cookie: cookie } : {}),
          ...(body ? { Origin: origin } : {}),
        },
        body: body ? new URLSearchParams(body) : undefined,
      })
    );
  return {
    values,
    claimHtml,
    recovery,
    env,
    calls,
    request,
    loseNextStartResponse() {
      dropStartResponse = true;
    },
    setJob(value: Record<string, unknown>) {
      job = value;
    },
  };
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
describe('authenticated maintenance deployment jobs', () => {
  it('requires owner authentication, same-origin mutation and explicit install approval', async () => {
    const f = await fixture();
    expect((await f.request('/deploy', { confirmed: 'yes' }, false)).status).toBe(401);
    expect(
      (await f.request('/deploy', { confirmed: 'yes' }, true, 'https://attacker.example')).status
    ).toBe(403);
    expect((await f.request('/deploy', {})).status).toBe(409);
    expect(f.calls.some((call) => call.path === '/start')).toBe(false);
    expect((await f.request('/deploy', { confirmed: 'yes' })).status).toBe(303);
    expect((await f.request('/deploy', { confirmed: 'yes' })).status).toBe(409);
  });
  it('pins owner identity from the durable manifest rather than changed environment config', async () => {
    const f = await fixture();
    await f.request('/');
    const config = JSON.parse(f.env.INSTALLATION_CONFIG as string);
    f.env.INSTALLATION_CONFIG = JSON.stringify({ ...config, ownerEmail: 'other@example.com' });
    await f.request('/deploy', { confirmed: 'yes' });
    expect(f.calls.find((call) => call.path === '/start')!.body!.ownerEmail).toBe(
      'owner@example.com'
    );
  });
  it('keeps setup credentials private and only reveals them after completion', async () => {
    const f = await fixture();
    expect((await f.request('/setup', {}, false)).status).toBe(401);
    expect((await f.request('/setup', {})).status).toBe(409);
    await f.request('/deploy', { confirmed: 'yes' });
    const initialJobId = f.calls.find((call) => call.path === '/start')!.body!.jobId;
    f.setJob({ status: 'completed', sourceCommit: original, jobId: initialJobId });
    const page = await f.request('/');
    expect(await page.text()).not.toContain('private-setup-token-for-owner');
    const setup = await f.request('/setup', {});
    expect(await setup.text()).toContain('private-setup-token-for-owner');
    expect(setup.headers.get('Cache-Control')).toBe('no-store');
  });
  it('requires a nonexpired one-use update approval for the exact selected release', async () => {
    const f = await fixture();
    await f.request('/deploy', { confirmed: 'yes' });
    const initialJobId = f.calls.find((call) => call.path === '/start')!.body!.jobId;
    f.setJob({ status: 'completed', sourceCommit: original, jobId: initialJobId });
    await f.request('/');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/releases/latest')) return Response.json({ tag_name: 'v-next' });
        if (url.endsWith('/commits/v-next')) return Response.json({ sha: updated });
        return supportedSourceFetch(input, init);
      })
    );
    const preview = await f.request('/update-preview', {});
    const approval = /name="approval" value="([a-f0-9]{64})"/.exec(await preview.text())![1]!;
    expect((await f.request('/update', { approval: 'wrong' })).status).toBe(409);
    expect((await f.request('/update', { approval })).status).toBe(303);
    const start = f.calls.filter((call) => call.path === '/start').at(-1)!.body!;
    expect(start.sourceCommit).toBe(updated);
    expect(start.previousSourceCommit).toBe(original);
    expect(start.ownerEmail).toBe('owner@example.com');
    f.setJob({ status: 'completed', sourceCommit: updated, jobId: start.jobId });
    expect((await f.request('/update', { approval })).status).toBe(409);
  });
  it('does not resume an old builder job after a newer approved request was durably recorded', async () => {
    const f = await fixture();
    await f.request('/');
    const manifest = f.values.get('installation') as Record<string, unknown>;
    manifest.requestedJobId = 'f'.repeat(32);
    (manifest.config as Record<string, unknown>).sourceCommit = updated;
    f.values.set('installation', manifest);
    f.setJob({ status: 'failed', sourceCommit: original, jobId: 'e'.repeat(32) });
    expect((await f.request('/resume', {})).status).toBe(409);
    expect(f.calls.some((call) => call.path === '/resume')).toBe(false);
  });
  it('does not promote unrelated completed builder output into the installation manifest', async () => {
    const f = await fixture();
    await f.request('/');
    const manifest = f.values.get('installation') as Record<string, unknown>;
    manifest.requestedJobId = 'f'.repeat(32);
    f.values.set('installation', manifest);
    f.setJob({ status: 'completed', sourceCommit: updated, jobId: 'e'.repeat(32) });
    await f.request('/');
    expect(
      (f.values.get('installation') as Record<string, unknown>).lastSuccessfulCommit
    ).toBeUndefined();
  });
});

it('reconciles a lost start response against the exact durably approved job without launching another job', async () => {
  const f = await fixture();
  f.loseNextStartResponse();
  expect((await f.request('/deploy', { confirmed: 'yes' })).status).toBe(500);
  const manifest = f.values.get('installation') as {
    requestedJob: { id: string; config: { sourceCommit: string }; accepted: boolean };
  };
  const approvedId = manifest.requestedJob.id;
  expect(manifest.requestedJob.config.sourceCommit).toBe(original);
  expect((await f.request('/')).status).toBe(200);
  expect(f.calls.filter((call) => call.path === '/start')).toHaveLength(1);
  const recovered = f.values.get('installation') as typeof manifest;
  expect(recovered.requestedJob.id).toBe(approvedId);
  expect(recovered.requestedJob.accepted).toBe(true);
});

it('shows real installation controls after claiming or recovering a configured service', async () => {
  const f = await fixture();
  expect(f.claimHtml).not.toContain('version updates are not connected yet');
  expect(f.claimHtml).toContain('href="/">Continue to installation controls');
  const recovered = await f.request('/recover', { recovery: f.recovery }, false);
  expect(recovered.status).toBe(200);
  const html = await recovered.text();
  expect(html).not.toContain('version updates are not connected yet');
  expect(html).toContain('href="/">Continue to installation controls');
});

it('recognizes completion before processing another stale first-install submission', async () => {
  const f = await fixture();
  await f.request('/deploy', { confirmed: 'yes' });
  const start = f.calls.find((call) => call.path === '/start')!.body!;
  f.setJob({ status: 'completed', sourceCommit: original, jobId: start.jobId });
  expect((await f.request('/deploy', { confirmed: 'yes' })).status).toBe(409);
  expect(f.calls.filter((call) => call.path === '/start')).toHaveLength(1);
});

it('does not send cancellation to a completed approved job', async () => {
  const f = await fixture();
  await f.request('/deploy', { confirmed: 'yes' });
  const start = f.calls.find((call) => call.path === '/start')!.body!;
  f.setJob({ status: 'completed', sourceCommit: original, jobId: start.jobId });
  await f.request('/cancel', {});
  expect(f.calls.filter((call) => call.path === '/cancel')).toHaveLength(0);
});

it('cancels a crash-persisted approval before starting compute and resumes exactly that approved job', async () => {
  const f = await fixture();
  await f.request('/');
  const manifest = f.values.get('installation') as Record<string, unknown>;
  const id = 'f'.repeat(32);
  const config = {
    ...(manifest.config as Record<string, unknown>),
    prefix: 's123456',
    environment: 'production',
    jobId: id,
  };
  manifest.requestedJobId = id;
  manifest.requestedJob = { id, config, accepted: false };
  f.values.set('installation', manifest);
  expect((await f.request('/cancel', {})).status).toBe(303);
  expect(f.calls.filter((call) => call.path === '/start')).toHaveLength(0);
  expect(f.calls.filter((call) => call.path === '/cancel')).toHaveLength(0);
  const cancelled = f.values.get('installation') as {
    requestedJob: { cancelledBeforeStart?: boolean; config: unknown };
  };
  expect(cancelled.requestedJob.cancelledBeforeStart).toBe(true);
  expect(cancelled.requestedJob.config).toEqual(config);
  const panel = await f.request('/');
  expect(await panel.text()).toContain('Build cancelled');
  expect(f.calls.filter((call) => call.path === '/start')).toHaveLength(0);
  expect((await f.request('/resume', {})).status).toBe(303);
  const starts = f.calls.filter((call) => call.path === '/start');
  expect(starts).toHaveLength(1);
  expect(starts[0]!.body).toEqual(config);
  expect(
    (f.values.get('installation') as typeof cancelled).requestedJob.cancelledBeforeStart
  ).toBeUndefined();
});

it('cancels a matching accepted job despite losing its start response without launching another job', async () => {
  const f = await fixture();
  f.loseNextStartResponse();
  expect((await f.request('/deploy', { confirmed: 'yes' })).status).toBe(500);
  const saved = f.values.get('installation') as {
    requestedJob: { accepted: boolean; cancelledBeforeStart?: boolean };
  };
  expect(saved.requestedJob.accepted).toBe(false);
  expect((await f.request('/cancel', {})).status).toBe(303);
  expect(f.calls.filter((call) => call.path === '/start')).toHaveLength(1);
  expect(f.calls.filter((call) => call.path === '/cancel')).toHaveLength(1);
  const reconciled = f.values.get('installation') as typeof saved;
  expect(reconciled.requestedJob.accepted).toBe(true);
  expect(reconciled.requestedJob.cancelledBeforeStart).toBeUndefined();
});

it('never cancels an unrelated active builder while cancelling an unaccepted queued approval', async () => {
  const f = await fixture();
  await f.request('/');
  const manifest = f.values.get('installation') as Record<string, unknown>;
  const id = 'f'.repeat(32);
  manifest.requestedJob = {
    id,
    config: { ...(manifest.config as Record<string, unknown>), jobId: id },
    accepted: false,
  };
  f.values.set('installation', manifest);
  f.setJob({ status: 'running', sourceCommit: updated, jobId: 'e'.repeat(32) });
  expect((await f.request('/cancel', {})).status).toBe(303);
  expect(f.calls.filter((call) => ['/cancel', '/start'].includes(call.path))).toHaveLength(0);
  await f.request('/');
  expect(f.calls.filter((call) => ['/cancel', '/start'].includes(call.path))).toHaveLength(0);
});

it.each(['behind', 'diverged', 'manifest', 'protocol', 'capability', 'engine', 'unavailable'])(
  'rejects %s release candidates before approval without changing the installed manifest',
  async (problem) => {
    const f = await fixture();
    await f.request('/deploy', { confirmed: 'yes' });
    const id = f.calls.find((call) => call.path === '/start')!.body!.jobId;
    f.setJob({ status: 'completed', sourceCommit: original, jobId: id });
    await f.request('/');
    const before = structuredClone(f.values.get('installation'));
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/releases/latest')) return Response.json({ tag_name: 'next' });
        if (url.endsWith('/commits/next')) return Response.json({ sha: updated });
        if (url.includes('/compare/') && ['behind', 'diverged'].includes(problem))
          return Response.json({ status: problem, ahead_by: 1, behind_by: 1 });
        if (problem === 'unavailable') throw new Error('network unavailable');
        if (problem === 'manifest' && url.endsWith('/installer-protocol.json'))
          return new Response(null, { status: 404 });
        if (url.endsWith('/installer-protocol.json'))
          return Response.json({
            ...supportedProtocol,
            ...(problem === 'protocol'
              ? { protocolVersion: 999 }
              : problem === 'capability'
                ? { capabilities: [] }
                : {}),
          });
        if (problem === 'engine' && url.endsWith('/installer-engine-cli.ts'))
          return new Response(null, { status: 404 });
        return supportedSourceFetch(input, init);
      })
    );
    expect((await f.request('/update-preview', {})).status).toBe(
      problem === 'unavailable' ? 502 : 409
    );
    expect(f.values.get('installation')).toEqual(before);
    expect(f.calls.filter((call) => call.path === '/start')).toHaveLength(1);
  }
);

it('revalidates immutable update source before consuming approval and preserves it on rejection', async () => {
  const f = await fixture();
  await f.request('/deploy', { confirmed: 'yes' });
  const id = f.calls.find((call) => call.path === '/start')!.body!.jobId;
  f.setJob({ status: 'completed', sourceCommit: original, jobId: id });
  await f.request('/');
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/releases/latest')) return Response.json({ tag_name: 'next' });
      if (url.endsWith('/commits/next')) return Response.json({ sha: updated });
      return supportedSourceFetch(input, init);
    })
  );
  const preview = await f.request('/update-preview', {});
  const approval = /name="approval" value="([a-f0-9]{64})"/.exec(await preview.text())![1]!;
  const before = structuredClone(f.values.get('installation'));
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ status: 'diverged', ahead_by: 2, behind_by: 2 }))
  );
  expect((await f.request('/update', { approval })).status).toBe(409);
  expect(f.values.get('installation')).toEqual(before);
  expect(f.calls.filter((call) => call.path === '/start')).toHaveLength(1);
});
