/**
 * Regression test for /api/config/artifacts-enabled.
 *
 * The endpoint must report Artifacts only when ARTIFACTS_ENABLED is set AND a backend exists.
 * Without the backend check the UI offers a provider that crashes on use (the 2026-04-25
 * Artifacts post-mortem). Since L16 the backend is the Cloudflare binding or, on a self-hosted
 * install, the backend its build registered.
 *
 * Mounts the real route module at the same path `src/index.ts` uses.
 */
import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';

import type { Env } from '../../../src/env';
import { artifactsConfigRoutes } from '../../../src/routes/artifacts-config';
import { registerArtifactsBackendFallback } from '../../../src/services/artifacts/backend';

const app = new Hono<{ Bindings: Env }>();
app.route('/api/config', artifactsConfigRoutes);

async function enabled(env: Partial<Env>): Promise<boolean> {
  const res = await app.request('/api/config/artifacts-enabled', {}, env as Env);
  expect(res.status).toBe(200);
  return ((await res.json()) as { enabled: boolean }).enabled;
}

const binding = { create: () => null, delete: () => null, get: () => null } as never;

afterEach(() => registerArtifactsBackendFallback(null));

describe('/api/config/artifacts-enabled', () => {
  it('returns false when both flag and binding are absent', async () => {
    expect(await enabled({})).toBe(false);
  });

  it('returns false when the flag is true but no binding exists (binding silently missing)', async () => {
    expect(await enabled({ ARTIFACTS_ENABLED: 'true' })).toBe(false);
  });

  it('returns true when both flag and binding are present', async () => {
    expect(await enabled({ ARTIFACTS_ENABLED: 'true', ARTIFACTS: binding })).toBe(true);
  });

  it('returns false when the binding exists but the flag is not set', async () => {
    expect(await enabled({ ARTIFACTS: binding })).toBe(false);
  });

  it('returns false when the flag is explicitly "false"', async () => {
    expect(await enabled({ ARTIFACTS_ENABLED: 'false', ARTIFACTS: binding })).toBe(false);
  });

  it('sets public-config cache headers', async () => {
    const res = await app.request('/api/config/artifacts-enabled', {}, {} as Env);
    expect(res.headers.get('Cache-Control')).toBeTruthy();
  });

  describe('with a self-host fallback backend registered', () => {
    it('returns true with the flag and no binding', async () => {
      registerArtifactsBackendFallback(() => binding);
      expect(await enabled({ ARTIFACTS_ENABLED: 'true' })).toBe(true);
    });

    it('still returns false without the flag', async () => {
      registerArtifactsBackendFallback(() => binding);
      expect(await enabled({})).toBe(false);
    });
  });
});
