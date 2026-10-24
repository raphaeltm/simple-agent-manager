import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { ttsRoutes } from '../../../src/routes/tts';

// Mock auth middleware to bypass authentication
vi.mock('../../../src/middleware/auth', () => ({
  requireAuth: () => vi.fn((_c: any, next: any) => next()),
  requireApproved: () => vi.fn((_c: any, next: any) => next()),
  getUserId: () => 'test-user-id',
  getAuth: () => ({ user: { id: 'test-user-id' } }),
}));

// Mock the TTS service so route tests don't exercise the full pipeline
vi.mock('../../../src/services/tts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/services/tts')>();
  return {
    ...actual,
    synthesizeSpeech: vi.fn(),
    getAudioFromR2: vi.fn(),
    // getTTSConfig is NOT mocked — it is a pure function and we want real behaviour
  };
});

import { getAudioFromR2,synthesizeSpeech } from '../../../src/services/tts';

// ─── Test helpers ─────────────────────────────────────────────────────────────

function buildApp() {
  const app = new Hono<{ Bindings: Env }>();

  app.onError((err, c) => {
    const appError = err as { statusCode?: number; error?: string; message?: string };
    if (typeof appError.statusCode === 'number' && typeof appError.error === 'string') {
      return c.json({ error: appError.error, message: appError.message }, appError.statusCode as 400 | 500);
    }
    return c.json({ error: 'INTERNAL_ERROR', message: err.message }, 500);
  });

  app.route('/api/tts', ttsRoutes);
  return app;
}

function createMockR2(): R2Bucket {
  return {
    get: vi.fn().mockResolvedValue(null),
    put: vi.fn().mockResolvedValue(undefined),
    head: vi.fn().mockResolvedValue(null),
    delete: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue({ objects: [], truncated: false }),
    createMultipartUpload: vi.fn(),
    resumeMultipartUpload: vi.fn(),
  } as unknown as R2Bucket;
}

function createEnv(overrides: Partial<Env> = {}): Env {
  return {
    AI: { run: vi.fn() } as unknown as Ai,
    R2: createMockR2(),
    ...overrides,
  } as unknown as Env;
}

// ─── POST /api/tts/synthesize ─────────────────────────────────────────────────

describe('POST /api/tts/synthesize', () => {
  let app: ReturnType<typeof buildApp>;

  beforeEach(() => {
    app = buildApp();
    vi.mocked(synthesizeSpeech).mockReset();
  });

  it('returns audioUrl and cached:false for a new synthesis', async () => {
    vi.mocked(synthesizeSpeech).mockResolvedValue({
      audioBody: new ArrayBuffer(1024),
      contentType: 'audio/mpeg',
      cached: false,
      summarized: false,
    });

    const res = await app.request('/api/tts/synthesize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Hello world', storageId: 'msg-123' }),
    }, createEnv());

    expect(res.status).toBe(200);
    const body = await res.json() as { audioUrl: string; cached: boolean };
    expect(body.audioUrl).toBe('/api/tts/audio/msg-123');
    expect(body.cached).toBe(false);
  });

  it('returns cached:true when audio already exists in R2', async () => {
    vi.mocked(synthesizeSpeech).mockResolvedValue({
      audioBody: new ReadableStream(),
      contentType: 'audio/mpeg',
      cached: true,
      summarized: false,
    });

    const res = await app.request('/api/tts/synthesize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Hello world', storageId: 'msg-already-cached' }),
    }, createEnv());

    expect(res.status).toBe(200);
    const body = await res.json() as { cached: boolean };
    expect(body.cached).toBe(true);
  });

  it('passes text and storageId to synthesizeSpeech', async () => {
    vi.mocked(synthesizeSpeech).mockResolvedValue({
      audioBody: new ArrayBuffer(512),
      contentType: 'audio/mpeg',
      cached: false,
      summarized: false,
    });

    const env = createEnv();
    await app.request('/api/tts/synthesize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Spoken words', storageId: 'msg-456' }),
    }, env);

    expect(synthesizeSpeech).toHaveBeenCalledWith(
      'Spoken words',
      'msg-456',
      env.AI,
      env.R2,
      expect.any(Object),
      'test-user-id',
      undefined,
    );
  });

  it('returns 400 when text is missing', async () => {
    const res = await app.request('/api/tts/synthesize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ storageId: 'msg-123' }),
    }, createEnv());

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string; message: string };
    expect(body.error).toBe('BAD_REQUEST');
    expect(body.message).toContain('Missing required fields');
  });

  it('returns 400 when storageId is missing', async () => {
    const res = await app.request('/api/tts/synthesize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Hello' }),
    }, createEnv());

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('BAD_REQUEST');
  });

  it('returns 400 when body is invalid JSON', async () => {
    const res = await app.request('/api/tts/synthesize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json',
    }, createEnv());

    expect(res.status).toBe(400);
  });

  it('returns 400 when storageId contains path traversal characters', async () => {
    const res = await app.request('/api/tts/synthesize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Hello', storageId: '../../../etc/passwd' }),
    }, createEnv());

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string; message: string };
    expect(body.error).toBe('BAD_REQUEST');
    expect(body.message).toContain('Invalid storageId format');
  });

  it('returns 400 when storageId contains special characters', async () => {
    const res = await app.request('/api/tts/synthesize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Hello', storageId: 'msg 123' }),
    }, createEnv());

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('BAD_REQUEST');
  });

  it('accepts storageId with hyphens and underscores', async () => {
    vi.mocked(synthesizeSpeech).mockResolvedValue({
      audioBody: new ArrayBuffer(512),
      contentType: 'audio/mpeg',
      cached: false,
      summarized: false,
    });

    const res = await app.request('/api/tts/synthesize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Hello', storageId: 'msg_abc-123' }),
    }, createEnv());

    expect(res.status).toBe(200);
  });

  it('returns 400 when TTS is disabled via env var', async () => {
    const res = await app.request('/api/tts/synthesize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Hello', storageId: 'msg-123' }),
    }, createEnv({ TTS_ENABLED: 'false' } as any));

    expect(res.status).toBe(400);
    const body = await res.json() as { message: string };
    expect(body.message).toContain('disabled');
  });

  it('returns 500 when synthesizeSpeech throws', async () => {
    vi.mocked(synthesizeSpeech).mockRejectedValue(new Error('Workers AI unavailable'));

    const res = await app.request('/api/tts/synthesize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Hello', storageId: 'msg-err' }),
    }, createEnv());

    expect(res.status).toBe(500);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('INTERNAL_ERROR');
  });

  it('returns 500 when TTS model returns empty audio', async () => {
    vi.mocked(synthesizeSpeech).mockRejectedValue(new Error('TTS model returned empty audio'));

    const res = await app.request('/api/tts/synthesize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Hello', storageId: 'empty-audio' }),
    }, createEnv());

    expect(res.status).toBe(500);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('INTERNAL_ERROR');
  });

  it('surfaces error details to the client for debugging', async () => {
    vi.mocked(synthesizeSpeech).mockRejectedValue(new Error('TTS model returned 503: Service Unavailable'));

    const res = await app.request('/api/tts/synthesize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Hello', storageId: 'msg-error' }),
    }, createEnv());

    expect(res.status).toBe(500);
    const body = await res.json() as { message: string };
    // Error details are surfaced to help users understand TTS failures
    expect(body.message).toContain('TTS synthesis failed');
    expect(body.message).toContain('TTS model returned 503');
  });
});

// ─── GET /api/tts/audio/:storageId ───────────────────────────────────────────

describe('GET /api/tts/audio/:storageId', () => {
  let app: ReturnType<typeof buildApp>;

  beforeEach(() => {
    app = buildApp();
    vi.mocked(getAudioFromR2).mockReset();
  });

  it('serves audio from R2 with correct Content-Type for mp3', async () => {
    const fakeStream = new ReadableStream();
    vi.mocked(getAudioFromR2).mockResolvedValue({
      body: fakeStream,
      size: 2048,
    } as unknown as R2ObjectBody);

    const res = await app.request('/api/tts/audio/msg-123', {}, createEnv());

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('audio/mpeg');
    expect(res.headers.get('Content-Length')).toBe('2048');
  });

  it('sets Cache-Control header for browser caching', async () => {
    vi.mocked(getAudioFromR2).mockResolvedValue({
      body: new ReadableStream(),
      size: 512,
    } as unknown as R2ObjectBody);

    const res = await app.request('/api/tts/audio/msg-123', {}, createEnv());

    expect(res.headers.get('Cache-Control')).toBe('private, max-age=86400');
  });

  it('serves wav audio with correct Content-Type from R2 metadata', async () => {
    // The route reads contentType from R2 httpMetadata set at store time
    vi.mocked(getAudioFromR2).mockResolvedValue({
      body: new ReadableStream(),
      size: 4096,
      httpMetadata: { contentType: 'audio/wav' },
    } as unknown as R2ObjectBody);

    const res = await app.request('/api/tts/audio/msg-wav', {}, createEnv());

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('audio/wav');
  });

  it('serves ogg audio with correct Content-Type from R2 metadata', async () => {
    vi.mocked(getAudioFromR2).mockResolvedValue({
      body: new ReadableStream(),
      size: 4096,
      httpMetadata: { contentType: 'audio/ogg' },
    } as unknown as R2ObjectBody);

    const res = await app.request('/api/tts/audio/msg-ogg', {}, createEnv());

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('audio/ogg');
  });

  it('falls back to audio/mpeg when R2 httpMetadata has no contentType', async () => {
    vi.mocked(getAudioFromR2).mockResolvedValue({
      body: new ReadableStream(),
      size: 1024,
      httpMetadata: undefined,
    } as unknown as R2ObjectBody);

    const res = await app.request('/api/tts/audio/msg-no-meta', {}, createEnv());

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('audio/mpeg');
  });

  it('returns 404 when audio does not exist in R2', async () => {
    vi.mocked(getAudioFromR2).mockResolvedValue(null);

    const res = await app.request('/api/tts/audio/nonexistent', {}, createEnv());

    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('NOT_FOUND');
  });

  it('returns 400 for storageId with path traversal dot-dot segments', async () => {
    // A storageId containing dots is not alphanumeric/hyphen/underscore only
    const res = await app.request('/api/tts/audio/..etc..passwd', {}, createEnv());

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('BAD_REQUEST');
  });

  it('returns 400 for storageId with spaces', async () => {
    // Spaces encoded as %20 in the URL
    const res = await app.request('/api/tts/audio/msg%20123', {}, createEnv());

    expect(res.status).toBe(400);
  });

  it('passes the storageId and config to getAudioFromR2', async () => {
    vi.mocked(getAudioFromR2).mockResolvedValue({
      body: new ReadableStream(),
      size: 256,
    } as unknown as R2ObjectBody);

    const env = createEnv();
    await app.request('/api/tts/audio/msg-lookup', {}, env);

    expect(getAudioFromR2).toHaveBeenCalledWith(
      env.R2,
      'msg-lookup',
      'test-user-id',
      expect.any(Object),
    );
  });
});
