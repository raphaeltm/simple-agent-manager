import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  provision: vi.fn(async () => 'https://smoke.example.workers.dev'),
  cloudflare: vi.fn(async () => ({})),
}));
vi.mock('../src/provision', () => ({ provision: mocks.provision }));
vi.mock('../src/cloudflare', () => ({ cloudflare: mocks.cloudflare }));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
  vi.clearAllMocks();
});
function setup(
  statuses: number[],
  later: { claim?: number[]; landing?: number[] } = {}
) {
  vi.stubEnv('INSTALLER_ENVIRONMENT', 'staging');
  vi.stubEnv('CLOUDFLARE_API_TOKEN', 'synthetic-deploy-token');
  vi.stubEnv('CLOUDFLARE_ACCOUNT_ID', 'a'.repeat(32));
  vi.stubEnv('BASE_DOMAIN', 'example.com');
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.stubGlobal('setTimeout', (callback: () => void) => {
    callback();
    return 0;
  });
  let rootRequests = 0;
  const claims = [...(later.claim ?? [])];
  const landings = [...(later.landing ?? [])];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      if (input.endsWith('/health')) return Response.json({ ok: true, kind: 'sam-maintenance' });
      if (input.endsWith('/claim')) {
        const status = claims.shift() ?? 200;
        return new Response(null, {
          status,
          headers: status === 200 ? { 'set-cookie': '__Host-test=synthetic; Path=/' } : {},
        });
      }
      if (init?.headers && 'Cookie' in init.headers) {
        const status = landings.shift() ?? 200;
        return new Response(status === 200 ? 'Ownership handoff verified.' : '', { status });
      }
      return new Response('', { status: statuses[Math.min(rootRequests++, statuses.length - 1)] });
    })
  );
  return () => rootRequests;
}
describe('bounded staging bootstrap verification', () => {
  it('waits for the workers.dev root to propagate after health becomes available, then verifies handoff and cleans up', async () => {
    const count = setup([404, 503, 401]);
    await import('../scripts/staging-smoke');
    expect(count()).toBe(3);
    expect(mocks.cloudflare).toHaveBeenLastCalledWith(
      'synthetic-deploy-token',
      expect.stringContaining('/workers/scripts/sam-installer-smoke-'),
      { method: 'DELETE' }
    );
  });
  it('fails immediately on public200 instead of retrying past an auth regression, and cleans up', async () => {
    const count = setup([200, 401]);
    await expect(import('../scripts/staging-smoke')).rejects.toThrow('anonymous=200');
    expect(count()).toBe(1);
    expect(mocks.cloudflare).toHaveBeenCalledOnce();
  });
  it('bounds propagation retries and cleans up on exhaustion', async () => {
    const count = setup([404]);
    await expect(import('../scripts/staging-smoke')).rejects.toThrow('propagation timed out');
    expect(count()).toBe(12);
    expect(mocks.cloudflare).toHaveBeenCalledOnce();
  });
  it('retries a claim and a landing that reach an edge not yet serving the Worker', async () => {
    setup([401], { claim: [404, 503], landing: [404] });
    await import('../scripts/staging-smoke');
    const requested = vi.mocked(fetch).mock.calls.map(([input]) => String(input));
    expect(requested.filter((input) => input.endsWith('/claim'))).toHaveLength(3);
    expect(mocks.cloudflare).toHaveBeenCalledOnce();
  });
  it.each([401, 403, 500])(
    'fails at once on a refused claim (%s) and reports the status',
    async (status) => {
      setup([401], { claim: [status, 200] });
      await expect(import('../scripts/staging-smoke')).rejects.toThrow(
        `Owner handoff failed; claim=${status}, cookie=false`
      );
      const requested = vi.mocked(fetch).mock.calls.map(([input]) => String(input));
      expect(requested.filter((input) => input.endsWith('/claim'))).toHaveLength(1);
      expect(mocks.cloudflare).toHaveBeenCalledOnce();
    }
  );
  it('fails at once when the owner session is rejected, and reports the status', async () => {
    setup([401], { landing: [401, 200] });
    await expect(import('../scripts/staging-smoke')).rejects.toThrow(
      'Authenticated bootstrap landing failed; landing=401'
    );
    expect(mocks.cloudflare).toHaveBeenCalledOnce();
  });
});
