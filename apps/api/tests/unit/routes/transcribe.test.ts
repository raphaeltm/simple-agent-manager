import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { DEFAULT_RATE_LIMITS } from '../../../src/middleware/rate-limit';
import { transcribeRoutes } from '../../../src/routes/transcribe';
import { createMemoryKv, createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const authState = vi.hoisted(() => ({ userId: 'test-user-id' }));

// Mock auth middleware; like the real `requireAuth`, it puts the caller on the context, which is
// what the per-user rate limit keys on.
vi.mock('../../../src/middleware/auth', () => ({
  requireAuth: () => async (c: any, next: any) => {
    c.set('auth', { user: { id: authState.userId }, session: { id: null } });
    await next();
  },
  requireApproved: () => vi.fn((_c: any, next: any) => next()),
  getUserId: () => authState.userId,
}));

describe('Transcribe Routes', () => {
  let app: Hono<{ Bindings: Env }>;
  let mockAI: { run: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    app = new Hono<{ Bindings: Env }>();

    // Add error handler to match production behavior
    app.onError((err, c) => {
      const appError = err as { statusCode?: number; error?: string; message?: string };
      if (typeof appError.statusCode === 'number' && typeof appError.error === 'string') {
        return c.json({ error: appError.error, message: appError.message }, appError.statusCode);
      }
      return c.json({ error: 'INTERNAL_ERROR', message: err.message }, 500);
    });

    app.route('/api/transcribe', transcribeRoutes);

    // Mock AI binding
    mockAI = {
      run: vi.fn().mockResolvedValue({ text: 'Hello world' }),
    };
  });

  function createEnv(overrides: Partial<Env> = {}): Env {
    return {
      AI: mockAI as any,
      DATABASE: createAiSpendRateLimitD1(),
      KV: createMemoryKv(),
      ...overrides,
    } as Env;
  }

  function createAiSpendRateLimitD1(): D1Database {
    const sqlite = new Database(':memory:');
    createSchemaTables(sqlite, [schema.aiSpendRateLimits]);
    return createSqliteD1(sqlite);
  }

  function createRacyEmptyKv(expectedGets: number): KVNamespace {
    let getCount = 0;
    let releaseGets: (() => void) | undefined;
    const allGetsStarted = new Promise<void>((resolve) => {
      releaseGets = resolve;
    });

    return {
      get: async () => {
        getCount += 1;
        if (getCount >= expectedGets) releaseGets?.();
        await allGetsStarted;
        return null;
      },
      put: vi.fn(async () => undefined),
    } as unknown as KVNamespace;
  }

  function deferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    const promise = new Promise<T>((innerResolve) => {
      resolve = innerResolve;
    });
    return { promise, resolve };
  }

  function postAudio(env: Env) {
    const formData = new FormData();
    formData.append('audio', new Blob(['fake-audio-data'], { type: 'audio/webm' }), 'clip.webm');
    return app.request('/api/transcribe', { method: 'POST', body: formData }, env);
  }

  describe('POST /api/transcribe', () => {
    it('should transcribe audio and return text', async () => {
      const formData = new FormData();
      const audioBlob = new Blob(['fake-audio-data'], { type: 'audio/webm' });
      formData.append('audio', audioBlob, 'recording.webm');

      const res = await app.request('/api/transcribe', {
        method: 'POST',
        body: formData,
      }, createEnv());

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ text: 'Hello world' });
      expect(mockAI.run).toHaveBeenCalledTimes(1);
      expect(mockAI.run).toHaveBeenCalledWith(
        '@cf/openai/whisper-large-v3-turbo',
        expect.objectContaining({ audio: expect.any(String) })
      );
    });

    it('should use configurable model ID from env', async () => {
      const formData = new FormData();
      const audioBlob = new Blob(['fake-audio-data'], { type: 'audio/webm' });
      formData.append('audio', audioBlob, 'recording.webm');

      const res = await app.request('/api/transcribe', {
        method: 'POST',
        body: formData,
      }, createEnv({ WHISPER_MODEL_ID: '@cf/openai/whisper-tiny-en' }));

      expect(res.status).toBe(200);
      expect(mockAI.run).toHaveBeenCalledWith(
        '@cf/openai/whisper-tiny-en',
        expect.objectContaining({ audio: expect.any(String) })
      );
    });

    it('should return 400 when audio field is missing', async () => {
      const formData = new FormData();
      formData.append('notaudio', 'some-text');

      const res = await app.request('/api/transcribe', {
        method: 'POST',
        body: formData,
      }, createEnv());

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('BAD_REQUEST');
      expect(body.message).toContain('Missing "audio" field');
    });

    it('should return 400 when audio file is empty', async () => {
      const formData = new FormData();
      const emptyBlob = new Blob([], { type: 'audio/webm' });
      formData.append('audio', emptyBlob, 'recording.webm');

      const res = await app.request('/api/transcribe', {
        method: 'POST',
        body: formData,
      }, createEnv());

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('BAD_REQUEST');
      expect(body.message).toContain('empty');
    });

    it('should return 400 when audio file exceeds size limit', async () => {
      const formData = new FormData();
      // Create a blob that exceeds the custom 100-byte limit
      const largeBlob = new Blob(['x'.repeat(200)], { type: 'audio/webm' });
      formData.append('audio', largeBlob, 'recording.webm');

      const res = await app.request('/api/transcribe', {
        method: 'POST',
        body: formData,
      }, createEnv({ MAX_AUDIO_SIZE_BYTES: '100' }));

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('BAD_REQUEST');
      expect(body.message).toContain('too large');
    });

    it('should return empty text when Whisper returns empty result', async () => {
      mockAI.run.mockResolvedValue({ text: '' });

      const formData = new FormData();
      const audioBlob = new Blob(['fake-audio-data'], { type: 'audio/webm' });
      formData.append('audio', audioBlob, 'recording.webm');

      const res = await app.request('/api/transcribe', {
        method: 'POST',
        body: formData,
      }, createEnv());

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ text: '' });
    });

    it('should trim whitespace from transcription result', async () => {
      mockAI.run.mockResolvedValue({ text: '  Hello world  ' });

      const formData = new FormData();
      const audioBlob = new Blob(['fake-audio-data'], { type: 'audio/webm' });
      formData.append('audio', audioBlob, 'recording.webm');

      const res = await app.request('/api/transcribe', {
        method: 'POST',
        body: formData,
      }, createEnv());

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ text: 'Hello world' });
    });

    it('should handle AI binding errors gracefully', async () => {
      mockAI.run.mockRejectedValue(new Error('Workers AI unavailable'));

      const formData = new FormData();
      const audioBlob = new Blob(['fake-audio-data'], { type: 'audio/webm' });
      formData.append('audio', audioBlob, 'recording.webm');

      const res = await app.request('/api/transcribe', {
        method: 'POST',
        body: formData,
      }, createEnv());

      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toBe('INTERNAL_ERROR');
    });

    it('should use default max size when env var is not set', async () => {
      const formData = new FormData();
      const audioBlob = new Blob(['fake-audio-data'], { type: 'audio/webm' });
      formData.append('audio', audioBlob, 'recording.webm');

      // No MAX_AUDIO_SIZE_BYTES set — should use default 10MB
      const res = await app.request('/api/transcribe', {
        method: 'POST',
        body: formData,
      }, createEnv());

      expect(res.status).toBe(200);
    });

    it('should handle null text in Whisper response', async () => {
      mockAI.run.mockResolvedValue({ text: null });

      const formData = new FormData();
      const audioBlob = new Blob(['fake-audio-data'], { type: 'audio/webm' });
      formData.append('audio', audioBlob, 'recording.webm');

      const res = await app.request('/api/transcribe', {
        method: 'POST',
        body: formData,
      }, createEnv());

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ text: '' });
    });
  });

  describe('rate limit (Workers AI spend)', () => {
    beforeEach(() => {
      authState.userId = 'test-user-id';
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-09-27T10:15:20Z'));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('admits the documented default of 30 per minute, then rejects without calling Whisper', async () => {
      // No override: the shipped default decides, resolved through the real limiter.
      const env = createEnv();
      expect(DEFAULT_RATE_LIMITS.TRANSCRIBE).toBe(30);

      for (let index = 0; index < 30; index += 1) {
        expect((await postAudio(env)).status).toBe(200);
      }
      const rejected = await postAudio(env);

      expect(rejected.status).toBe(429);
      await expect(rejected.json()).resolves.toMatchObject({ error: 'RATE_LIMIT_EXCEEDED' });
      // 10:15:20 inside the 10:15:00–10:16:00 window: 40 seconds until it refills.
      expect(rejected.headers.get('Retry-After')).toBe('40');
      expect(mockAI.run).toHaveBeenCalledTimes(30);
    });

    it('refills when the next one-minute window starts', async () => {
      const env = createEnv({ RATE_LIMIT_TRANSCRIBE: '1' });
      vi.setSystemTime(new Date('2026-09-27T10:15:59Z'));

      expect((await postAudio(env)).status).toBe(200);
      expect((await postAudio(env)).status).toBe(429);

      vi.setSystemTime(new Date('2026-09-27T10:16:00Z'));
      expect((await postAudio(env)).status).toBe(200);
      expect(mockAI.run).toHaveBeenCalledTimes(2);
    });

    it('honours a window override', async () => {
      const env = createEnv({
        RATE_LIMIT_TRANSCRIBE: '1',
        RATE_LIMIT_TRANSCRIBE_WINDOW_SECONDS: '3600',
      });

      expect((await postAudio(env)).status).toBe(200);
      vi.setSystemTime(new Date('2026-09-27T10:17:00Z'));
      expect((await postAudio(env)).status).toBe(429);
    });

    it('limits each user separately', async () => {
      const env = createEnv({ RATE_LIMIT_TRANSCRIBE: '1' });

      expect((await postAudio(env)).status).toBe(200);
      expect((await postAudio(env)).status).toBe(429);

      authState.userId = 'another-user';
      expect((await postAudio(env)).status).toBe(200);
    });

    it('admits exactly the configured limit under parallel same-user transcription requests', async () => {
      const limit = 2;
      const totalRequests = 10;
      const aiGate = deferred<{ text: string }>();
      const enteredLimit = deferred<void>();
      let aiCallsStarted = 0;
      mockAI.run.mockImplementation(async () => {
        aiCallsStarted += 1;
        if (aiCallsStarted === limit) enteredLimit.resolve();
        return aiGate.promise;
      });
      const env = createEnv({
        RATE_LIMIT_TRANSCRIBE: String(limit),
        KV: createRacyEmptyKv(totalRequests),
      });

      const responses = Array.from({ length: totalRequests }, () => postAudio(env));
      await enteredLimit.promise;
      aiGate.resolve({ text: 'Hello world' });
      const statuses = await Promise.all(responses).then((items) => items.map((res) => res.status));

      expect(statuses.filter((status) => status === 200)).toHaveLength(limit);
      expect(statuses.filter((status) => status === 429)).toHaveLength(totalRequests - limit);
      expect(mockAI.run).toHaveBeenCalledTimes(limit);
    });

    it('fails closed without calling Whisper when the atomic counter is unavailable', async () => {
      const env = createEnv({
        DATABASE: {
          prepare: () => {
            throw new Error('D1 unavailable');
          },
        } as unknown as D1Database,
      });

      const res = await postAudio(env);

      expect(res.status).toBe(503);
      await expect(res.json()).resolves.toMatchObject({ error: 'RATE_LIMIT_UNAVAILABLE' });
      expect(res.headers.get('X-RateLimit-Limit')).toBe('30');
      expect(res.headers.get('X-RateLimit-Remaining')).toBe('0');
      expect(mockAI.run).not.toHaveBeenCalled();
    });
  });
});
