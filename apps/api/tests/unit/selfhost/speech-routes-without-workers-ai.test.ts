/**
 * POST /api/transcribe and POST /api/tts/synthesize on an installation with no Workers AI
 * binding (a Workers-compatible runtime such as celld) versus one that has it (Cloudflare).
 *
 * Both routes are mounted behind the real global error handler (`handleAppError`, the one
 * src/index.ts installs), so the assertions see the same JSON a client sees. The TTS slice runs
 * the real synthesis service with a plain-text input (no markdown, so no cleanup model call) and
 * an AI stub that answers the way Workers AI does, so the absent case reaches the same
 * `ai.run` dereference production would have hit before the guard existed.
 */
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { handleAppError } from '../../../src/middleware/app-error-handler';
import { transcribeRoutes } from '../../../src/routes/transcribe';
import { ttsRoutes } from '../../../src/routes/tts';
import { createMemoryKv, createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

vi.mock('../../../src/middleware/auth', () => ({
  requireAuth: () => async (c: any, next: any) => {
    c.set('auth', { user: { id: 'user-speech-1' }, session: { id: null } });
    await next();
  },
  requireApproved: () => async (_c: any, next: any) => next(),
  getUserId: () => 'user-speech-1',
  getAuth: () => ({ user: { id: 'user-speech-1' } }),
}));

function buildApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.onError(handleAppError);
  app.route('/api/transcribe', transcribeRoutes);
  app.route('/api/tts', ttsRoutes);
  return app;
}

function aiSpendRateLimitD1(): D1Database {
  const sqlite = new Database(':memory:');
  createSchemaTables(sqlite, [schema.aiSpendRateLimits]);
  return createSqliteD1(sqlite);
}

function createR2() {
  const stored = new Map<string, ArrayBuffer>();
  const r2 = {
    get: vi.fn().mockResolvedValue(null),
    head: vi.fn().mockResolvedValue(null),
    put: vi.fn(async (key: string, value: ArrayBuffer) => {
      stored.set(key, value);
    }),
    delete: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue({ objects: [], truncated: false }),
  } as unknown as R2Bucket;
  return { r2, stored };
}

/** Workers AI answers a Whisper call with `{ text }` and a TTS call with a raw audio Response. */
function createWorkersAi() {
  return {
    run: vi.fn(
      async (model: string, _input: unknown, options?: { returnRawResponse?: boolean }) => {
        if (options?.returnRawResponse) {
          return new Response(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), {
            headers: { 'Content-Type': 'audio/mpeg' },
          });
        }
        expect(model).toContain('whisper');
        return { text: 'Hello from the microphone' };
      }
    ),
  };
}

function baseEnv(overrides: Record<string, unknown> = {}): Env {
  return {
    DATABASE: aiSpendRateLimitD1(),
    KV: createMemoryKv(),
    R2: createR2().r2,
    // Keep the synthesis retry loop fast if a code path does reach a failing model call.
    TTS_RETRY_BASE_DELAY_MS: '1',
    ...overrides,
  } as unknown as Env;
}

function postAudio(app: ReturnType<typeof buildApp>, env: Env) {
  const form = new FormData();
  form.append('audio', new Blob(['fake-audio-data'], { type: 'audio/webm' }), 'clip.webm');
  return app.request('/api/transcribe', { method: 'POST', body: form }, env);
}

function postSynthesize(app: ReturnType<typeof buildApp>, env: Env, storageId = 'msg-speech-1') {
  return app.request(
    '/api/tts/synthesize',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Read this reply aloud please.', storageId }),
    },
    env
  );
}

describe('POST /api/transcribe', () => {
  let app: ReturnType<typeof buildApp>;
  beforeEach(() => {
    app = buildApp();
  });

  it('with the Workers AI binding transcribes the upload (Cloudflare behaviour)', async () => {
    const ai = createWorkersAi();

    const res = await postAudio(app, baseEnv({ AI: ai }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: 'Hello from the microphone' });
    expect(ai.run).toHaveBeenCalledTimes(1);
    expect(ai.run).toHaveBeenCalledWith(
      '@cf/openai/whisper-large-v3-turbo',
      expect.objectContaining({ audio: expect.any(String) })
    );
  });

  it('without the binding answers 404 FEATURE_UNAVAILABLE for speechToText', async () => {
    const res = await postAudio(app, baseEnv());

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: 'FEATURE_UNAVAILABLE',
      message: 'Speech-to-text is not available on this installation',
      details: { feature: 'speechToText' },
    });
  });

  it('treats an AI binding with no run method as absent, not as a server error', async () => {
    const res = await postAudio(app, baseEnv({ AI: {} }));

    expect(res.status).toBe(404);
    expect((await res.json()) as { details: { feature: string } }).toMatchObject({
      details: { feature: 'speechToText' },
    });
  });
});

describe('POST /api/tts/synthesize', () => {
  let app: ReturnType<typeof buildApp>;
  beforeEach(() => {
    app = buildApp();
  });

  it('with the Workers AI binding synthesizes, stores the audio and reports its URL', async () => {
    const ai = createWorkersAi();
    const { r2, stored } = createR2();

    const res = await postSynthesize(app, baseEnv({ AI: ai, R2: r2 }), 'msg-cf-1');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      audioUrl: '/api/tts/audio/msg-cf-1',
      cached: false,
      summarized: false,
    });
    expect(ai.run).toHaveBeenCalledTimes(1);
    expect(ai.run).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ text: 'Read this reply aloud please.' }),
      { returnRawResponse: true }
    );
    expect([...stored.keys()].some((key) => key.includes('msg-cf-1'))).toBe(true);
  });

  it('without the binding answers 404 FEATURE_UNAVAILABLE for textToSpeech', async () => {
    const { r2, stored } = createR2();

    const res = await postSynthesize(app, baseEnv({ R2: r2 }));
    const text = await res.text();

    expect(res.status).toBe(404);
    expect(JSON.parse(text)).toEqual({
      error: 'FEATURE_UNAVAILABLE',
      message: 'Text-to-speech is not available on this installation',
      details: { feature: 'textToSpeech' },
    });
    // The pre-guard failure surfaced as a 500 wrapping the TypeError text.
    expect(text).not.toContain('Cannot read properties');
    expect(text).not.toContain('TTS synthesis failed');
    expect(stored.size).toBe(0);
  });

  it('keeps TTS_ENABLED=false as its own 400, distinct from the unavailable case', async () => {
    const disabledWithAi = await postSynthesize(
      app,
      baseEnv({ AI: createWorkersAi(), TTS_ENABLED: 'false' })
    );
    const disabledWithoutAi = await postSynthesize(app, baseEnv({ TTS_ENABLED: 'false' }));

    expect(disabledWithAi.status).toBe(400);
    expect(disabledWithoutAi.status).toBe(400);
  });
});
