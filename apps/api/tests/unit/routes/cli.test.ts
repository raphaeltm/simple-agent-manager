import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { cliRoutes } from '../../../src/routes/cli';

function createApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.route('/api/cli', cliRoutes);
  return app;
}

function createBinaryObject(bytes: Uint8Array) {
  return {
    body: new Response(bytes).body,
    size: bytes.byteLength,
  };
}

function createJsonObject(value: unknown) {
  return {
    json: vi.fn().mockResolvedValue(value),
    size: JSON.stringify(value).length,
  };
}

function createEnvWithR2(get: ReturnType<typeof vi.fn>) {
  return {
    R2: { get },
  } as unknown as Env;
}

describe('CLI routes', () => {
  const app = createApp();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('streams the macOS arm64 binary with attachment headers', async () => {
    const bytes = new Uint8Array([0xcf, 0xfa, 0xed, 0xfe, 0x0c]);
    const get = vi.fn().mockResolvedValue(createBinaryObject(bytes));

    const res = await app.request(
      '/api/cli/download?os=darwin&arch=arm64',
      {},
      createEnvWithR2(get)
    );

    expect(res.status).toBe(200);
    expect(get).toHaveBeenCalledWith('cli/sam-darwin-arm64');
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    expect(res.headers.get('content-disposition')).toBe(
      'attachment; filename="sam-darwin-arm64"'
    );
    expect(res.headers.get('content-length')).toBe(String(bytes.byteLength));
    expect(res.headers.get('cache-control')).toBe('public, max-age=3600');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
  });

  it('rejects unsupported platforms before reading R2', async () => {
    const get = vi.fn();

    const res = await app.request(
      '/api/cli/download?os=windows&arch=amd64',
      {},
      createEnvWithR2(get)
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: 'INVALID_PLATFORM',
      message: 'Unsupported platform: windows-amd64',
    });
    expect(get).not.toHaveBeenCalled();
  });

  it('returns not configured when the R2 binding is missing', async () => {
    const res = await app.request(
      '/api/cli/download?os=linux&arch=amd64',
      {},
      {} as Env
    );

    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({
      error: 'NOT_CONFIGURED',
      message: 'CLI binary storage not configured',
    });
  });

  it('returns not found when the selected binary is missing', async () => {
    const get = vi.fn().mockResolvedValue(null);

    const res = await app.request(
      '/api/cli/download?os=linux&arch=arm64',
      {},
      createEnvWithR2(get)
    );

    expect(res.status).toBe(404);
    expect(get).toHaveBeenCalledWith('cli/sam-linux-arm64');
    expect(await res.json()).toMatchObject({
      error: 'NOT_FOUND',
      message: 'CLI binary not found for linux-arm64',
    });
  });

  it('returns available version metadata', async () => {
    const metadata = { version: 'v1.2.3', buildDate: '2026-05-28T12:00:00Z' };
    const get = vi.fn().mockResolvedValue(createJsonObject(metadata));

    const res = await app.request('/api/cli/version', {}, createEnvWithR2(get));

    expect(res.status).toBe(200);
    expect(get).toHaveBeenCalledWith('cli/version.json');
    expect(await res.json()).toEqual({ ...metadata, available: true });
  });

  it('returns unavailable version metadata when version.json is missing', async () => {
    const get = vi.fn().mockResolvedValue(null);

    const res = await app.request('/api/cli/version', {}, createEnvWithR2(get));

    expect(res.status).toBe(200);
    expect(get).toHaveBeenCalledWith('cli/version.json');
    expect(await res.json()).toEqual({
      available: false,
      version: null,
      buildDate: null,
    });
  });
});
