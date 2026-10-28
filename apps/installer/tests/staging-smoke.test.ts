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
function setup(statuses: number[]) {
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
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      if (input.endsWith('/health'))
        return Response.json({ ok: true, kind: 'sam-maintenance' });
      if (input.endsWith('/claim'))
        return new Response(null, {
          status: 200,
          headers: { 'set-cookie': '__Host-test=synthetic; Path=/' },
        });
      if (init?.headers && 'Cookie' in init.headers)
        return new Response('Ownership handoff verified.');
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
});
