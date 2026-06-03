import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';

let currentRole: 'user' | 'superadmin' = 'user';

vi.mock('../../../src/middleware/auth', () => ({
  requireAuth: () => async (c: any, next: () => Promise<void>) => {
    c.set('auth', {
      user: {
        id: 'user-1',
        email: 'user@example.com',
        name: 'Test User',
        avatarUrl: null,
        role: currentRole,
        status: 'active',
      },
      session: { id: 'session-1', expiresAt: new Date(Date.now() + 3600_000) },
    });
    await next();
  },
  requireApproved: () => async (_c: unknown, next: () => Promise<void>) => next(),
  requireSuperadmin: () => async (c: any, next: () => Promise<void>) => {
    if (c.get('auth')?.user?.role !== 'superadmin') {
      return c.json({ error: 'FORBIDDEN', message: 'Superadmin access required' }, 403);
    }
    await next();
  },
  getAuth: (c: any) => c.get('auth'),
}));

vi.mock('../../../src/services/tts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/services/tts')>();
  return {
    ...actual,
    generateSpeechAudioChunk: vi.fn(async () => new Uint8Array([1, 2, 3, 4]).buffer),
    storeAudioInR2: vi.fn(async () => undefined),
  };
});

import { ttsBenchmarkRoutes } from '../../../src/routes/tts-benchmark';
import { generateSpeechAudioChunk, storeAudioInR2 } from '../../../src/services/tts';

function buildApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.onError((err, c) => {
    const appError = err as { statusCode?: number; error?: string; message?: string };
    if (typeof appError.statusCode === 'number' && typeof appError.error === 'string') {
      return c.json({ error: appError.error, message: appError.message }, appError.statusCode as 400 | 500);
    }
    return c.json({ error: 'INTERNAL_ERROR', message: err.message }, 500);
  });
  app.route('/api/admin/tts-benchmark', ttsBenchmarkRoutes);
  return app;
}

function createEnv(): Env {
  return {
    AI: { run: vi.fn() } as unknown as Ai,
    R2: {
      get: vi.fn().mockResolvedValue(null),
      put: vi.fn().mockResolvedValue(undefined),
      head: vi.fn().mockResolvedValue(null),
      delete: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockResolvedValue({ objects: [], truncated: false }),
      createMultipartUpload: vi.fn(),
      resumeMultipartUpload: vi.fn(),
    } as unknown as R2Bucket,
  } as unknown as Env;
}

describe('POST /api/admin/tts-benchmark', () => {
  beforeEach(() => {
    currentRole = 'user';
    vi.mocked(generateSpeechAudioChunk).mockClear();
    vi.mocked(storeAudioInR2).mockClear();
  });

  it('returns 403 for a non-superadmin', async () => {
    const app = buildApp();

    const res = await app.request('/api/admin/tts-benchmark', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ variants: ['no-cleanup'], iterations: 1, text: '## Hello\n\n- world' }),
    }, createEnv());

    expect(res.status).toBe(403);
    expect(generateSpeechAudioChunk).not.toHaveBeenCalled();
  });

  it('is reachable for a superadmin and exercises TTS and R2 boundaries', async () => {
    currentRole = 'superadmin';
    const app = buildApp();
    const env = createEnv();

    const res = await app.request('/api/admin/tts-benchmark', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ variants: ['no-cleanup'], iterations: 1, text: '## Hello\n\n- world' }),
    }, env);

    expect(res.status).toBe(200);
    const body = await res.json() as {
      variants: Array<{ name: string; runs: Array<{ chunkCount: number; errors: string[] }> }>;
    };
    expect(body.variants[0]?.name).toBe('no-cleanup');
    expect(body.variants[0]?.runs[0]?.chunkCount).toBe(1);
    expect(body.variants[0]?.runs[0]?.errors).toEqual([]);
    expect(generateSpeechAudioChunk).toHaveBeenCalledWith(expect.stringContaining('Hello'), env.AI, expect.any(Object));
    expect(storeAudioInR2).toHaveBeenCalledWith(
      env.R2,
      expect.stringMatching(/^bench_/),
      'user-1',
      expect.any(ArrayBuffer),
      expect.any(Object),
    );
    expect(env.R2.delete).toHaveBeenCalledWith(expect.stringMatching(/^tts\/user-1\/bench_[a-f0-9]+\.mp3$/));
  });
});
