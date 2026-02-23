import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../../../src/index';
import { transcribeRoutes } from '../../../src/routes/transcribe';

// Mock auth middleware
vi.mock('../../../src/middleware/auth', () => ({
  requireAuth: () => vi.fn((_c: any, next: any) => next()),
  requireApproved: () => vi.fn((_c: any, next: any) => next()),
  getUserId: () => 'test-user-id',
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
      ...overrides,
    } as Env;
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
});
