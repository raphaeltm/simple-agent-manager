/**
 * A4 + A5 (overnight B3): voice input and server read-aloud on an installation without the
 * Workers AI binding, through admin-configured OpenAI-compatible speech endpoints.
 *
 * Real routes (`/api/transcribe`, `/api/tts/synthesize`, `/api/tts/audio/:id`), the real global
 * error handler, the real admin settings store (SQLite, secret keys encrypted) and the real public
 * capabilities resolver. Stubbed: auth middleware, R2 (in-memory) and the provider (global fetch).
 *
 * Controls: with nothing configured both routes still answer 404 FEATURE_UNAVAILABLE and the
 * capabilities stay false; with the Workers AI binding the endpoint settings are never read.
 */
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { handleAppError } from '../../../src/middleware/app-error-handler';
import { transcribeRoutes } from '../../../src/routes/transcribe';
import { ttsRoutes } from '../../../src/routes/tts';
import type { AdminSettingName } from '../../../src/services/admin-setting-definitions';
import { updateAdminSettings } from '../../../src/services/admin-settings-mutations';
import { __resetAdminSettingsCacheForTest } from '../../../src/services/admin-settings-resolution';
import { resolvePublicPlatformCapabilities } from '../../../src/services/speech-endpoints';
import { createAdminSettingsEnv } from '../../helpers/admin-settings-env';
import { createSchemaTables } from '../../helpers/sqlite-d1';

vi.mock('../../../src/middleware/auth', () => ({
  requireAuth: () => async (c: any, next: any) => {
    c.set('auth', { user: { id: 'user-speech-1' }, session: { id: null } });
    await next();
  },
  requireApproved: () => async (_c: any, next: any) => next(),
  getUserId: () => 'user-speech-1',
  getAuth: () => ({ user: { id: 'user-speech-1' } }),
}));

const STT_KEY = 'sk-stt-endpoint-key-000000000';
const TTS_KEY = 'sk-tts-endpoint-key-000000000';
const AUDIO_BYTES = new Uint8Array([0x49, 0x44, 0x33, 4, 5, 6, 7, 8]);

const fetchMock = vi.fn();

function createR2() {
  const stored = new Map<string, ArrayBuffer>();
  const r2 = {
    get: vi.fn(async (key: string) => {
      const value = stored.get(key);
      if (!value) return null;
      return {
        body: new Response(value).body,
        size: value.byteLength,
        httpMetadata: { contentType: 'audio/mpeg' },
        arrayBuffer: async () => value,
      };
    }),
    put: vi.fn(async (key: string, value: ArrayBuffer) => {
      stored.set(key, value);
    }),
    delete: vi.fn().mockResolvedValue(undefined),
  } as unknown as R2Bucket;
  return { r2, stored };
}

function boxEnv(overrides: Partial<Env> = {}) {
  const fixture = createAdminSettingsEnv({
    R2: createR2().r2,
    TTS_RETRY_BASE_DELAY_MS: '1',
    TTS_RETRY_ATTEMPTS: '1',
    ...overrides,
  });
  createSchemaTables(fixture.sqlite, [schema.aiSpendRateLimits]);
  return fixture;
}

async function configure(env: Env, values: Partial<Record<AdminSettingName, unknown>>) {
  await updateAdminSettings(env, {
    changes: Object.entries(values).map(([name, value]) => ({
      name: name as AdminSettingName,
      value: value as never,
    })),
    actorUserId: 'admin-1',
  });
  __resetAdminSettingsCacheForTest();
}

function app() {
  const hono = new Hono<{ Bindings: Env }>();
  hono.onError(handleAppError);
  hono.route('/api/transcribe', transcribeRoutes);
  hono.route('/api/tts', ttsRoutes);
  return hono;
}

function postAudio(env: Env) {
  const form = new FormData();
  form.append('audio', new Blob(['fake-opus-bytes'], { type: 'audio/webm' }), 'clip.webm');
  return app().request('/api/transcribe', { method: 'POST', body: form }, env);
}

function postSynthesize(env: Env, text = '**Done.** I fixed the `export` pagination bug.') {
  return app().request(
    '/api/tts/synthesize',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, storageId: 'msg-1' }),
    },
    env
  );
}

beforeEach(() => {
  __resetAdminSettingsCacheForTest();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('speech-to-text through an OpenAI-compatible endpoint (A4)', () => {
  it('transcribes through the endpoint and the capability turns on', async () => {
    const { env } = boxEnv();
    await configure(env, {
      'speech.transcription.baseUrl': 'https://stt.example.com/v1',
      'speech.transcription.apiKey': STT_KEY,
      'speech.transcription.model': 'whisper-large-v3',
    });
    fetchMock.mockResolvedValueOnce(Response.json({ text: '  Fix the export job  ' }));

    const res = await postAudio(env);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: 'Fix the export job' });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://stt.example.com/v1/audio/transcriptions');
    expect(new Headers(init.headers).get('Authorization')).toBe(`Bearer ${STT_KEY}`);
    const form = init.body as FormData;
    expect(form.get('model')).toBe('whisper-large-v3');
    expect(form.get('response_format')).toBe('json');
    expect(form.get('file')).toBeInstanceOf(Blob);
    expect((await resolvePublicPlatformCapabilities(env)).speechToText).toBe(true);
  });

  it('answers 503 (not 500) and does not echo the upstream body when the endpoint fails', async () => {
    const { env } = boxEnv();
    await configure(env, {
      'speech.transcription.baseUrl': 'https://stt.example.com/v1',
      'speech.transcription.model': 'whisper-large-v3',
    });
    fetchMock.mockResolvedValueOnce(new Response('secret upstream detail', { status: 401 }));

    const res = await postAudio(env);
    expect(res.status).toBe(503);
    expect(await res.text()).not.toContain('secret upstream detail');
  });

  it('refuses a private-network endpoint until the admin opts in', async () => {
    const { env } = boxEnv();
    await configure(env, {
      'speech.transcription.baseUrl': 'http://127.0.0.1:8000/v1',
      'speech.transcription.model': 'Systran/faster-whisper-small',
    });
    expect((await postAudio(env)).status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await resolvePublicPlatformCapabilities(env)).speechToText).toBe(false);

    await configure(env, { 'speech.transcription.allowPrivateNetwork': true });
    fetchMock.mockResolvedValueOnce(Response.json({ text: 'local whisper' }));
    const res = await postAudio(env);
    expect(res.status).toBe(200);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://127.0.0.1:8000/v1/audio/transcriptions');
  });

  it('a base URL without a model stays off (control)', async () => {
    const { env } = boxEnv();
    await configure(env, { 'speech.transcription.baseUrl': 'https://stt.example.com/v1' });
    const res = await postAudio(env);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: 'FEATURE_UNAVAILABLE' });
  });
});

describe('server read-aloud through an OpenAI-compatible endpoint (A5)', () => {
  it('synthesizes plain text through the endpoint, stores it and serves it back', async () => {
    const { env } = boxEnv();
    await configure(env, {
      'speech.synthesis.baseUrl': 'https://tts.example.com/v1',
      'speech.synthesis.apiKey': TTS_KEY,
      'speech.synthesis.model': 'kokoro',
      'speech.synthesis.voice': 'af_heart',
    });
    fetchMock.mockResolvedValueOnce(
      new Response(AUDIO_BYTES, { headers: { 'Content-Type': 'audio/mpeg' } })
    );

    const res = await postSynthesize(env);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ audioUrl: '/api/tts/audio/msg-1', cached: false });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://tts.example.com/v1/audio/speech');
    expect(new Headers(init.headers).get('Authorization')).toBe(`Bearer ${TTS_KEY}`);
    const body = JSON.parse(String(init.body)) as Record<string, string>;
    expect(body).toMatchObject({ model: 'kokoro', voice: 'af_heart', response_format: 'mp3' });
    // Markdown stripped by the regex fallback (no Workers AI cleanup model here).
    expect(body.input).toBe('Done. I fixed the export pagination bug.');

    const audio = await app().request('/api/tts/audio/msg-1', {}, env);
    expect(audio.status).toBe(200);
    expect(new Uint8Array(await audio.arrayBuffer())).toEqual(AUDIO_BYTES);
    expect((await resolvePublicPlatformCapabilities(env)).textToSpeech).toBe(true);
  });

  it('rate-limits endpoint synthesis per user and hides endpoint errors from the client', async () => {
    const { env } = boxEnv({ RATE_LIMIT_TTS_SYNTHESIZE: '1' } as Partial<Env>);
    await configure(env, {
      'speech.synthesis.baseUrl': 'https://tts.example.com/v1',
      'speech.synthesis.model': 'kokoro',
    });
    fetchMock.mockResolvedValue(
      new Response('upstream says: tts.example.com quota', { status: 400 })
    );

    const failed = await postSynthesize(env);
    expect(failed.status).toBe(503);
    expect(await failed.text()).not.toContain('tts.example.com');

    const limited = await postSynthesize(env);
    expect(limited.status).toBe(429);
  });

  it('TTS_ENABLED=false still turns read-aloud off even with an endpoint', async () => {
    const { env } = boxEnv({ TTS_ENABLED: 'false' });
    await configure(env, {
      'speech.synthesis.baseUrl': 'https://tts.example.com/v1',
      'speech.synthesis.model': 'kokoro',
    });
    expect((await postSynthesize(env)).status).toBe(400);
    expect((await resolvePublicPlatformCapabilities(env)).textToSpeech).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('controls', () => {
  it('with nothing configured, both routes answer FEATURE_UNAVAILABLE and capabilities stay off', async () => {
    const { env } = boxEnv();
    const stt = await postAudio(env);
    const tts = await postSynthesize(env);
    expect(stt.status).toBe(404);
    expect(tts.status).toBe(404);
    expect(await stt.json()).toMatchObject({ error: 'FEATURE_UNAVAILABLE' });
    expect(await resolvePublicPlatformCapabilities(env)).toMatchObject({
      speechToText: false,
      textToSpeech: false,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('with the Workers AI binding the endpoint settings are not consulted (Cloudflare)', async () => {
    const ai = {
      run: vi.fn(async () => ({ text: 'from whisper on Workers AI' })),
    };
    const { env } = boxEnv({ AI: ai as unknown as Ai });
    await configure(env, {
      'speech.transcription.baseUrl': 'https://stt.example.com/v1',
      'speech.transcription.model': 'whisper-large-v3',
    });

    const res = await postAudio(env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: 'from whisper on Workers AI' });
    expect(ai.run).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await resolvePublicPlatformCapabilities(env)).toMatchObject({
      speechToText: true,
      textToSpeech: true,
    });
  });
});
