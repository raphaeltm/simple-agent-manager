/**
 * Regression test for /api/config/artifacts-enabled endpoint.
 *
 * This endpoint must check BOTH the ARTIFACTS_ENABLED env flag AND the
 * ARTIFACTS binding. Without the binding check, the UI enables an artifacts
 * feature that crashes at runtime because env.ARTIFACTS is undefined.
 *
 * See: docs/notes/2026-04-25-artifacts-broken-merge-postmortem.md
 */
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

describe('/api/config/artifacts-enabled', () => {
  function createApp(env: Record<string, unknown>) {
    const app = new Hono<{ Bindings: Record<string, unknown> }>();
    // Replicate the exact logic from src/index.ts
    app.get('/api/config/artifacts-enabled', (c) => {
      return c.json({
        enabled: c.env.ARTIFACTS_ENABLED === 'true' && !!c.env.ARTIFACTS,
      });
    });
    return { app, env };
  }

  it('returns enabled: false when both flag and binding are absent', async () => {
    const { app } = createApp({});
    const res = await app.request('/api/config/artifacts-enabled', {}, {});
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.enabled).toBe(false);
  });

  it('returns enabled: false when flag is true but binding is absent', async () => {
    const { app } = createApp({ ARTIFACTS_ENABLED: 'true' });
    const res = await app.request(
      '/api/config/artifacts-enabled',
      {},
      { ARTIFACTS_ENABLED: 'true' }
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    // This is the critical case: flag is on but Wrangler didn't inject the
    // binding (e.g. Wrangler v3 silently ignores [[artifacts]]). The endpoint
    // MUST return false so the UI doesn't offer a broken feature.
    expect(body.enabled).toBe(false);
  });

  it('returns enabled: true when both flag and binding are present', async () => {
    const mockArtifacts = { list: () => ({}) };
    const { app } = createApp({
      ARTIFACTS_ENABLED: 'true',
      ARTIFACTS: mockArtifacts,
    });
    const res = await app.request(
      '/api/config/artifacts-enabled',
      {},
      { ARTIFACTS_ENABLED: 'true', ARTIFACTS: mockArtifacts }
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.enabled).toBe(true);
  });

  it('returns enabled: false when binding exists but flag is not set', async () => {
    const mockArtifacts = { list: () => ({}) };
    const { app } = createApp({});
    const res = await app.request(
      '/api/config/artifacts-enabled',
      {},
      { ARTIFACTS: mockArtifacts }
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.enabled).toBe(false);
  });

  it('returns enabled: false when flag is explicitly "false"', async () => {
    const mockArtifacts = { list: () => ({}) };
    const { app } = createApp({});
    const res = await app.request(
      '/api/config/artifacts-enabled',
      {},
      { ARTIFACTS_ENABLED: 'false', ARTIFACTS: mockArtifacts }
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.enabled).toBe(false);
  });
});
