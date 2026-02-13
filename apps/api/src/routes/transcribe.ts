import { Hono } from 'hono';
import type { Env } from '../index';
import { requireAuth } from '../middleware/auth';
import { errors } from '../middleware/error';

/** Default Whisper model — configurable via WHISPER_MODEL_ID env var (Constitution Principle XI) */
const DEFAULT_WHISPER_MODEL = '@cf/openai/whisper-large-v3-turbo';

/** Default max audio size: 10 MB (configurable via MAX_AUDIO_SIZE_BYTES) */
const DEFAULT_MAX_AUDIO_SIZE_BYTES = 10_485_760;

/**
 * Convert an ArrayBuffer to a base64 string.
 * Uses chunked approach to avoid call stack limits with large buffers.
 */
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 8192;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

const transcribeRoutes = new Hono<{ Bindings: Env }>();

// Apply auth middleware to all routes
transcribeRoutes.use('*', requireAuth());

/**
 * POST /api/transcribe
 *
 * Accepts audio via multipart/form-data (field name: "audio") and returns
 * transcribed text using Cloudflare Workers AI (Whisper).
 *
 * Response: { text: string }
 */
transcribeRoutes.post('/', async (c) => {
  const maxAudioSizeBytes = parseInt(
    c.env.MAX_AUDIO_SIZE_BYTES || String(DEFAULT_MAX_AUDIO_SIZE_BYTES),
    10
  );

  // Parse multipart form data
  const formData = await c.req.parseBody();
  const audioFile = formData['audio'];

  if (!audioFile || !(audioFile instanceof File)) {
    throw errors.badRequest('Missing "audio" field in multipart form data');
  }

  // Validate file size > 0
  if (audioFile.size === 0) {
    throw errors.badRequest('Audio file is empty');
  }

  // Validate file size within limit
  if (audioFile.size > maxAudioSizeBytes) {
    throw errors.badRequest(
      `Audio file too large. Maximum size is ${Math.round(maxAudioSizeBytes / 1_048_576)}MB`,
      { maxBytes: maxAudioSizeBytes, actualBytes: audioFile.size }
    );
  }

  // Convert audio to base64 for Workers AI Whisper input
  const audioBuffer = await audioFile.arrayBuffer();
  const audioBase64 = arrayBufferToBase64(audioBuffer);

  // Determine model ID (configurable via env var, per Constitution Principle XI)
  const modelId = (c.env.WHISPER_MODEL_ID || DEFAULT_WHISPER_MODEL) as
    '@cf/openai/whisper-large-v3-turbo';

  // Call Workers AI Whisper model
  const result = await c.env.AI.run(modelId, {
    audio: audioBase64,
  });

  // Extract transcribed text from result
  const text = result?.text ?? '';

  return c.json({ text: text.trim() });
});

export { transcribeRoutes };
