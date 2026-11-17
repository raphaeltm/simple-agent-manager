/**
 * L14: voice input and server read-aloud on a runtime without the Workers AI binding, through the
 * self-host build's admin-configured OpenAI-compatible speech endpoints (src/selfhost/speech/).
 *
 * Real: the routes (`/api/transcribe`, `/api/tts/synthesize`, `/api/tts/audio/:id`), the global
 * error handler, the speech seam (services/speech-backend.ts), the self-host installer, the admin
 * settings store (SQLite, secret keys encrypted, written through `updateAdminSettings`),
 * `guardedFetch` and the public capabilities resolver. Stubbed: auth middleware, R2 (in memory)
 * and the provider (global fetch).
 *
 * Controls: Cloudflare (Workers AI bound) never consults the backend even when it is installed
 * and configured; a runtime with nothing installed answers FEATURE_UNAVAILABLE exactly as before.
 */
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { handleAppError } from '../../../src/middleware/app-error-handler';
import { transcribeRoutes } from '../../../src/routes/transcribe';
import { ttsRoutes } from '../../../src/routes/tts';
import { installSpeechEndpoints, speechEndpointBackend } from '../../../src/selfhost/speech';
import type { AdminSettingName } from '../../../src/services/admin-setting-definitions';
import { updateAdminSettings } from '../../../src/services/admin-settings-mutations';
import {
  findAdminSetting,
  resetInstalledAdminSettingDefinitionsForTests,
} from '../../../src/services/admin-settings-registry';
import { __resetAdminSettingsCacheForTest } from '../../../src/services/admin-settings-resolution';
import {
  resetSpeechBackendExtensionForTests,
  resolvePublicPlatformCapabilities,
} from '../../../src/services/speech-backend';
import { createAdminSettingsEnv } from '../../helpers/admin-settings-env';
import { applySqliteMigration } from '../../helpers/sqlite-d1';

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
  fixture.sqlite.exec(`CREATE TABLE users (id TEXT PRIMARY KEY);
    INSERT INTO users VALUES ('user-speech-1'), ('other-user');`);
  for (const filename of ['0174_ai_spend_rate_limits.sql', '0259_speech_synthesis_rate_limits.sql']) {
    applySqliteMigration(fixture.sqlite, new URL(`../../../src/db/migrations/${filename}`, import.meta.url));
  }
  return fixture;
}

async function configure(env: Env, values: Record<string, unknown>) {
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

function postSynthesize(env: Env, storageId = 'msg-1') {
  return app().request(
    '/api/tts/synthesize',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: '**Done.** I fixed the `export` pagination bug.',
        storageId,
      }),
    },
    env
  );
}

function workersAi() {
  return {
    run: vi.fn(
      async (_model: string, _input: unknown, options?: { returnRawResponse?: boolean }) =>
        options?.returnRawResponse
          ? new Response(AUDIO_BYTES, { headers: { 'Content-Type': 'audio/mpeg' } })
          : { text: 'from whisper on Workers AI' }
    ),
  };
}

beforeEach(() => {
  resetSpeechBackendExtensionForTests();
  resetInstalledAdminSettingDefinitionsForTests();
  __resetAdminSettingsCacheForTest();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  installSpeechEndpoints();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetSpeechBackendExtensionForTests();
  resetInstalledAdminSettingDefinitionsForTests();
});

describe('speech-to-text through an OpenAI-compatible endpoint', () => {
  it('transcribes through the endpoint and the capability turns on', async () => {
    const { env } = boxEnv();
    expect((await resolvePublicPlatformCapabilities(env)).speechToText).toBe(false);
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
    expect(init.redirect).toBe('manual');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const form = init.body as FormData;
    expect(form.get('model')).toBe('whisper-large-v3');
    expect(form.get('response_format')).toBe('json');
    expect(form.get('file')).toBeInstanceOf(Blob);
    expect((await resolvePublicPlatformCapabilities(env)).speechToText).toBe(true);
  });

  it.each([undefined, '1', '99'])(
    'bounds transcription JSON with Content-Length=%s before parsing',
    async (length) => {
      const { env } = boxEnv();
      await configure(env, {
        'speech.transcription.baseUrl': 'https://stt.example.com/v1',
        'speech.transcription.model': 'whisper-large-v3',
        'speech.transcription.maxResponseBytes': 13,
      });
      const cancel = vi.fn();
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(JSON.stringify({ text: 'oversized transcript' }))
          );
        },
        cancel,
      });
      fetchMock.mockResolvedValueOnce(
        new Response(stream, {
          headers: {
            'Content-Type': 'application/json',
            ...(length ? { 'Content-Length': length } : {}),
          },
        })
      );
      expect((await postAudio(env)).status).toBe(503);
      expect(cancel).toHaveBeenCalledTimes(1);
      fetchMock.mockResolvedValueOnce(Response.json({ text: 'ok' })); // exactly13bytes
      const control = await postAudio(env);
      expect(control.status).toBe(200);
      expect(await control.json()).toEqual({ text: 'ok' });
    }
  );

  it('answers 503 (not 500) and does not echo the upstream body when the endpoint fails', async () => {
    const { env } = boxEnv();
    await configure(env, {
      'speech.transcription.baseUrl': 'https://stt.example.com/v1',
      'speech.transcription.model': 'whisper-large-v3',
    });
    fetchMock.mockResolvedValueOnce(new Response('secret upstream detail', { status: 401 }));

    const res = await postAudio(env);
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(text).not.toContain('secret upstream detail');
    expect(text).not.toContain('stt.example.com');
  });

  it('refuses a redirect to cloud metadata and never sends the key there', async () => {
    const { env } = boxEnv();
    await configure(env, {
      'speech.transcription.baseUrl': 'https://stt.example.com/v1',
      'speech.transcription.apiKey': STT_KEY,
      'speech.transcription.model': 'whisper-large-v3',
    });
    fetchMock.mockResolvedValueOnce(
      new Response(null, {
        status: 307,
        headers: { Location: 'http://169.254.169.254/latest/meta-data/' },
      })
    );

    const res = await postAudio(env);
    expect(res.status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(1);
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

  it('keeps the configurable audio size limit in front of the endpoint', async () => {
    const { env } = boxEnv({ MAX_AUDIO_SIZE_BYTES: '4' } as Partial<Env>);
    await configure(env, {
      'speech.transcription.baseUrl': 'https://stt.example.com/v1',
      'speech.transcription.model': 'whisper-large-v3',
    });
    const res = await postAudio(env);
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('server read-aloud through an OpenAI-compatible endpoint', () => {
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
    expect(await res.json()).toEqual({
      audioUrl: '/api/tts/audio/msg-1',
      cached: false,
      summarized: false,
    });
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

  it('keeps synthesis unavailable until a voice is configured', async () => {
    const { env } = boxEnv();
    await configure(env, {
      'speech.synthesis.baseUrl': 'https://tts.example.com/v1',
      'speech.synthesis.model': 'tts-1',
    });
    expect((await resolvePublicPlatformCapabilities(env)).textToSpeech).toBe(false);
    expect((await postSynthesize(env)).status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
    await configure(env, { 'speech.synthesis.voice': 'alloy' });
    fetchMock.mockResolvedValueOnce(new Response(AUDIO_BYTES));
    expect((await postSynthesize(env)).status).toBe(200);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1].body)).voice).toBe('alloy');
  });

  it.each(['application/json', 'text/html'])(
    'refuses successful %s without caching',
    async (contentType) => {
      const { r2, stored } = createR2();
      const { env } = boxEnv({ R2: r2 });
      await configure(env, {
        'speech.synthesis.baseUrl': 'https://tts.example.com/v1',
        'speech.synthesis.model': 'kokoro',
        'speech.synthesis.voice': 'af_heart',
      });
      fetchMock.mockResolvedValueOnce(
        new Response('not audio', { headers: { 'Content-Type': contentType } })
      );
      expect((await postSynthesize(env)).status).toBe(503);
      expect(stored.size).toBe(0);
    }
  );

  it.each([undefined, '1', '99'])(
    'bounds response bytes with Content-Length=%s and cancels the body',
    async (length) => {
      const { r2, stored } = createR2();
      const { env } = boxEnv({ R2: r2 });
      await configure(env, {
        'speech.synthesis.baseUrl': 'https://tts.example.com/v1',
        'speech.synthesis.model': 'kokoro',
        'speech.synthesis.voice': 'af_heart',
        'speech.synthesis.maxAudioBytes': 4,
      });
      const cancel = vi.fn();
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(AUDIO_BYTES);
        },
        cancel,
      });
      fetchMock.mockResolvedValueOnce(
        new Response(stream, {
          headers: {
            'Content-Type': 'audio/mpeg',
            ...(length ? { 'Content-Length': length } : {}),
          },
        })
      );
      expect((await postSynthesize(env)).status).toBe(503);
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(stored.size).toBe(0);
      // The configured boundary admits exactly four bytes.
      fetchMock.mockResolvedValueOnce(new Response(AUDIO_BYTES.slice(0, 4)));
      expect((await postSynthesize(env)).status).toBe(200);
    }
  );

  it('regenerates every partial chunk after the backend settings change', async () => {
    const { r2, stored } = createR2();
    const { env } = boxEnv({ R2: r2, TTS_CHUNK_SIZE: '40' });
    await configure(env, {
      'speech.synthesis.baseUrl': 'https://old.example.com/v1',
      'speech.synthesis.model': 'kokoro',
      'speech.synthesis.voice': 'af_heart',
    });
    const request = () =>
      app().request(
        '/api/tts/synthesize',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text: 'A short sentence here. Another sentence to read. A final sentence now.',
            storageId: 'partial',
          }),
        },
        env
      );
    fetchMock.mockResolvedValueOnce(new Response(AUDIO_BYTES));
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 503 }));
    expect((await request()).status).toBe(503);
    expect(stored.size).toBe(0);
    await configure(env, {
      'speech.synthesis.baseUrl': 'https://new.example.com/v1',
      'speech.synthesis.model': 'tts-1',
      'speech.synthesis.voice': 'alloy',
    });
    fetchMock.mockClear();
    fetchMock.mockImplementation(async () => new Response(AUDIO_BYTES));
    expect((await request()).status).toBe(200);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
    for (const [url, init] of fetchMock.mock.calls) {
      expect(url).toBe('https://new.example.com/v1/audio/speech');
      expect(JSON.parse(String(init.body))).toMatchObject({ model: 'tts-1', voice: 'alloy' });
    }
    expect(stored.size).toBe(1); // only final audio, never partial backend chunks
  });

  it('rejects declared audio that does not match requested MP3 without caching', async () => {
    const { r2, stored } = createR2();
    const { env } = boxEnv({ R2: r2 });
    await configure(env, {
      'speech.synthesis.baseUrl': 'https://tts.example.com/v1',
      'speech.synthesis.model': 'kokoro',
      'speech.synthesis.voice': 'af_heart',
    });
    fetchMock.mockResolvedValueOnce(
      new Response(AUDIO_BYTES, { headers: { 'Content-Type': 'audio/wav' } })
    );
    expect((await postSynthesize(env)).status).toBe(503);
    expect(stored.size).toBe(0);
    fetchMock.mockResolvedValueOnce(
      new Response(AUDIO_BYTES, { headers: { 'Content-Type': 'audio/mp3' } })
    );
    expect((await postSynthesize(env)).status).toBe(200);
  });

  it('bounds the combined audio from all chunks and resets the budget for a new request', async () => {
    const { r2, stored } = createR2();
    const { env } = boxEnv({ R2: r2, TTS_CHUNK_SIZE: '40' });
    await configure(env, {
      'speech.synthesis.baseUrl': 'https://tts.example.com/v1',
      'speech.synthesis.model': 'kokoro',
      'speech.synthesis.voice': 'af_heart',
      'speech.synthesis.maxAudioBytes': 12,
    });
    const cancel = vi.fn();
    fetchMock.mockResolvedValueOnce(new Response(AUDIO_BYTES)); // eight of twelve
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(AUDIO_BYTES);
      },
      cancel,
    });
    fetchMock.mockResolvedValueOnce(new Response(stream)); // individually fits; total exceeds
    const res = await app().request(
      '/api/tts/synthesize',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: 'A short sentence here. Another sentence to read. A final sentence now.',
          storageId: 'aggregate',
        }),
      },
      env
    );
    expect(res.status).toBe(503);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(stored.size).toBe(0);
    fetchMock.mockResolvedValueOnce(new Response(AUDIO_BYTES));
    fetchMock.mockResolvedValueOnce(new Response(AUDIO_BYTES.slice(0, 4)));
    const exact = await app().request(
      '/api/tts/synthesize',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: 'A short sentence here. Another sentence to read.',
          storageId: 'exact-total',
        }),
      },
      env
    );
    expect(exact.status).toBe(200);
    expect([...stored.values()][0]?.byteLength).toBe(12);
  });

  it('atomically admits only the configured number of concurrent paid requests', async () => {
    const { env } = boxEnv();
    await configure(env, {
      'speech.synthesis.baseUrl': 'https://tts.example.com/v1',
      'speech.synthesis.model': 'kokoro',
      'speech.synthesis.voice': 'af_heart',
      'speech.synthesis.maxRequestsPerHour': 1,
    });
    fetchMock.mockImplementation(async () => new Response(AUDIO_BYTES));
    // Hold the old KV limiter's reads together so every contender observes the empty bucket.
    const originalGet = env.KV.get.bind(env.KV);
    let reads = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(env.KV, 'get').mockImplementation(async (key, options) => {
      if (key.startsWith('ratelimit:speech-synthesis:')) {
        if (++reads === 6) release();
        await barrier;
        return null;
      }
      return originalGet(key, options);
    });

    const responses = await Promise.all(
      Array.from({ length: 6 }, (_, index) => postSynthesize(env, `concurrent-${index}`))
    );
    expect(responses.map((response) => response.status).sort()).toEqual([
      200, 429, 429, 429, 429, 429,
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('isolates users, rolls over the hourly counter, and leaves transcription counters intact', async () => {
    const { env, sqlite } = boxEnv();
    await configure(env, {
      'speech.synthesis.baseUrl': 'https://tts.example.com/v1',
      'speech.synthesis.model': 'kokoro',
      'speech.synthesis.voice': 'af_heart',
      'speech.synthesis.maxRequestsPerHour': 1,
    });
    const start = Math.floor(Date.now() / 3_600_000) * 3600;
    sqlite.prepare('INSERT INTO ai_spend_rate_limits VALUES (?, ?, ?, ?)')
      .run('transcribe', 'user-speech-1', start, 29);
    sqlite.prepare('INSERT INTO speech_synthesis_rate_limits VALUES (?, ?, ?, ?)')
      .run('speech-synthesis', 'other-user', start, 99);
    fetchMock.mockImplementation(async () => new Response(AUDIO_BYTES));
    expect((await postSynthesize(env, 'hour-one')).status).toBe(200);
    expect((await postSynthesize(env, 'hour-one-refused')).status).toBe(429);
    vi.spyOn(Date, 'now').mockReturnValue((start + 3600) * 1000);
    expect((await postSynthesize(env, 'hour-two')).status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sqlite.prepare('SELECT count FROM ai_spend_rate_limits').get()).toEqual({ count: 29 });
    expect(sqlite.prepare('SELECT count FROM speech_synthesis_rate_limits WHERE user_id = ?')
      .get('other-user')).toEqual({ count: 99 });
  });

  it('fails closed without exposing database errors when the atomic counter is unavailable', async () => {
    const { env, sqlite } = boxEnv();
    await configure(env, {
      'speech.synthesis.baseUrl': 'https://tts.example.com/v1',
      'speech.synthesis.model': 'kokoro',
      'speech.synthesis.voice': 'af_heart',
    });
    sqlite.exec('DROP TABLE speech_synthesis_rate_limits');
    const response = await postSynthesize(env);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('speech_synthesis_rate_limits');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rate-limits per user and hides endpoint errors from the client', async () => {
    const { env } = boxEnv();
    await configure(env, {
      'speech.synthesis.baseUrl': 'https://tts.example.com/v1',
      'speech.synthesis.model': 'kokoro',
      'speech.synthesis.voice': 'af_heart',
      'speech.synthesis.maxRequestsPerHour': 1,
    });
    fetchMock.mockResolvedValue(
      new Response('upstream says: tts.example.com quota', { status: 400 })
    );

    const failed = await postSynthesize(env);
    expect(failed.status).toBe(503);
    expect(await failed.text()).not.toContain('tts.example.com');
    const callsAfterFirst = fetchMock.mock.calls.length;

    const limited = await postSynthesize(env, 'msg-2');
    expect(limited.status).toBe(429);
    expect(fetchMock.mock.calls.length).toBe(callsAfterFirst);
  });

  it('calls the endpoint once per chunk (no retry) and answers 503 on a transient failure', async () => {
    const { env } = boxEnv({ TTS_RETRY_ATTEMPTS: '3' });
    await configure(env, {
      'speech.synthesis.baseUrl': 'https://tts.example.com/v1',
      'speech.synthesis.model': 'kokoro',
      'speech.synthesis.voice': 'af_heart',
    });
    fetchMock.mockResolvedValueOnce(new Response('busy', { status: 503 }));
    fetchMock.mockResolvedValue(new Response(AUDIO_BYTES));

    const res = await postSynthesize(env);
    expect(res.status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('refuses empty audio from the endpoint instead of storing it', async () => {
    const { r2, stored } = createR2();
    const { env } = boxEnv({ R2: r2 });
    await configure(env, {
      'speech.synthesis.baseUrl': 'https://tts.example.com/v1',
      'speech.synthesis.model': 'kokoro',
      'speech.synthesis.voice': 'af_heart',
    });
    fetchMock.mockResolvedValueOnce(new Response(new Uint8Array()));

    const res = await postSynthesize(env);
    expect(res.status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(stored.size).toBe(0);
  });

  it('bounds the text sent to the endpoint by the configurable chunk limits', async () => {
    const { env } = boxEnv({ TTS_CHUNK_SIZE: '40', TTS_MAX_CHUNKS: '3' } as Partial<Env>);
    await configure(env, {
      'speech.synthesis.baseUrl': 'https://tts.example.com/v1',
      'speech.synthesis.model': 'kokoro',
      'speech.synthesis.voice': 'af_heart',
    });
    fetchMock.mockImplementation(async () => new Response(AUDIO_BYTES));

    const res = await app().request(
      '/api/tts/synthesize',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: 'One short sentence here. '.repeat(40),
          storageId: 'msg-long',
        }),
      },
      env
    );
    expect(res.status).toBe(200);
    const sent = fetchMock.mock.calls
      .map(
        ([, init]) => (JSON.parse(String((init as RequestInit).body)) as { input: string }).input
      )
      .join(' ');
    // chunk size x (max chunks - 1) = 80 characters of the 1,000 sent.
    expect(sent.replace(/\s+/g, ' ').trim().length).toBeLessThanOrEqual(80);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(0);
  });

  it('uses the configured endpoint timeout for every request', async () => {
    const { env } = boxEnv();
    await configure(env, {
      'speech.transcription.baseUrl': 'https://stt.example.com/v1',
      'speech.transcription.model': 'whisper-large-v3',
      'speech.endpointTimeoutMs': 4_321,
    });
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    fetchMock.mockResolvedValueOnce(Response.json({ text: 'ok' }));

    expect((await postAudio(env)).status).toBe(200);
    expect(timeout).toHaveBeenCalledWith(4_321);
  });

  it('TTS_ENABLED=false still turns read-aloud off even with an endpoint', async () => {
    const { env } = boxEnv({ TTS_ENABLED: 'false' });
    await configure(env, {
      'speech.synthesis.baseUrl': 'https://tts.example.com/v1',
      'speech.synthesis.model': 'kokoro',
      'speech.synthesis.voice': 'af_heart',
    });
    expect((await postSynthesize(env)).status).toBe(400);
    expect((await resolvePublicPlatformCapabilities(env)).textToSpeech).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('Cloudflare behaviour is unchanged', () => {
  it('with the Workers AI binding the backend is never consulted, even when configured', async () => {
    const ai = workersAi();
    const { env } = boxEnv({ AI: ai as unknown as Ai });
    await configure(env, {
      'speech.transcription.baseUrl': 'https://stt.example.com/v1',
      'speech.transcription.model': 'whisper-large-v3',
      'speech.synthesis.baseUrl': 'https://tts.example.com/v1',
      'speech.synthesis.model': 'kokoro',
      'speech.synthesis.voice': 'af_heart',
    });
    const transcription = vi.spyOn(speechEndpointBackend, 'transcription');
    const synthesis = vi.spyOn(speechEndpointBackend, 'synthesis');

    const stt = await postAudio(env);
    expect(stt.status).toBe(200);
    expect(await stt.json()).toEqual({ text: 'from whisper on Workers AI' });
    expect((await postSynthesize(env)).status).toBe(200);
    expect(await resolvePublicPlatformCapabilities(env)).toMatchObject({
      speechToText: true,
      textToSpeech: true,
    });

    // Whisper, then the markdown cleanup model and the TTS model: all on Workers AI.
    expect(ai.run).toHaveBeenCalledWith(
      expect.stringContaining('whisper'),
      expect.objectContaining({ audio: expect.any(String) })
    );
    expect(ai.run).toHaveBeenCalledWith(expect.any(String), expect.anything(), {
      returnRawResponse: true,
    });
    expect(transcription).not.toHaveBeenCalled();
    expect(synthesis).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('with nothing installed, a runtime without Workers AI answers FEATURE_UNAVAILABLE', async () => {
    const { env } = boxEnv();
    await configure(env, {
      'speech.transcription.baseUrl': 'https://stt.example.com/v1',
      'speech.transcription.model': 'whisper-large-v3',
    });
    // The Cloudflare Worker entry never installs the backend.
    resetSpeechBackendExtensionForTests();

    const stt = await postAudio(env);
    const tts = await postSynthesize(env);
    expect(stt.status).toBe(404);
    expect(await stt.json()).toEqual({
      error: 'FEATURE_UNAVAILABLE',
      message: 'Speech-to-text is not available on this installation',
      details: { feature: 'speechToText' },
    });
    expect(tts.status).toBe(404);
    expect(await resolvePublicPlatformCapabilities(env)).toMatchObject({
      speechToText: false,
      textToSpeech: false,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('capabilities', () => {
  it('reports a backend that cannot answer as absent, and keeps the other one', async () => {
    const { env } = boxEnv();
    await configure(env, {
      'speech.synthesis.baseUrl': 'https://tts.example.com/v1',
      'speech.synthesis.model': 'kokoro',
      'speech.synthesis.voice': 'af_heart',
    });
    vi.spyOn(speechEndpointBackend, 'transcription').mockRejectedValueOnce(new Error('boom'));

    expect(await resolvePublicPlatformCapabilities(env)).toMatchObject({
      speechToText: false,
      textToSpeech: true,
    });
  });
});

describe('settings registration', () => {
  it('registers the speech settings only when the self-host entry installs them', () => {
    expect(findAdminSetting('speech.synthesis.baseUrl')).toBeDefined();
    resetInstalledAdminSettingDefinitionsForTests();
    expect(findAdminSetting('speech.synthesis.baseUrl')).toBeUndefined();
    expect(findAdminSetting('speech.endpointTimeoutMs')).toBeUndefined();
  });

  it('installing twice is a no-op, and a clashing name is refused', async () => {
    expect(() => installSpeechEndpoints()).not.toThrow();
    const { installAdminSettingDefinitions } =
      await import('../../../src/services/admin-settings-registry');
    const clash = { ...findAdminSetting('speech.synthesis.model')! };
    expect(() => installAdminSettingDefinitions([clash])).toThrow(/already registered/);
  });
});
