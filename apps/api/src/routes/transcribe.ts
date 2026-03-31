import { Hono } from 'hono';
import type { Env } from '../index';
import { createModuleLogger, serializeError } from '../lib/logger';
import { requireAuth, requireApproved } from '../middleware/auth';
import { errors } from '../middleware/error';

const log = createModuleLogger('transcribe');

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
transcribeRoutes.use('*', requireAuth(), requireApproved());

/**
 * POST /api/transcribe
 *
 * Accepts audio via multipart/form-data (field name: "audio") and returns
 * transcribed text using Cloudflare Workers AI (Whisper).
 *
 * Response: { text: string }
 */
transcribeRoutes.post('/', async (c) => {
  const startTime = Date.now();
  log.info('request_received');

  const maxAudioSizeBytes = parseInt(
    c.env.MAX_AUDIO_SIZE_BYTES || String(DEFAULT_MAX_AUDIO_SIZE_BYTES),
    10
  );

  // Parse multipart form data
  let formData: Record<string, string | File>;
  try {
    formData = await c.req.parseBody();
    log.info('form_data_parsed', { fields: Object.keys(formData).join(', ') });
  } catch (parseErr) {
    log.error('form_data_parse_failed', serializeError(parseErr));
    throw errors.badRequest('Failed to parse multipart form data');
  }

  const audioFile = formData['audio'];

  if (!audioFile || typeof audioFile === 'string') {
    log.error('missing_or_invalid_audio_field', {
      hasAudioKey: 'audio' in formData,
      audioType: typeof audioFile,
    });
    throw errors.badRequest('Missing "audio" field in multipart form data');
  }

  log.info('audio_file_received', {
    name: audioFile.name,
    type: audioFile.type,
    size: audioFile.size,
    sizeKB: Math.round(audioFile.size / 1024),
  });

  // Validate file size > 0
  if (audioFile.size === 0) {
    log.error('audio_file_empty');
    throw errors.badRequest('Audio file is empty');
  }

  // Validate file size within limit
  if (audioFile.size > maxAudioSizeBytes) {
    log.error('audio_file_too_large', {
      size: audioFile.size,
      maxSize: maxAudioSizeBytes,
    });
    throw errors.badRequest(
      `Audio file too large. Maximum size is ${Math.round(maxAudioSizeBytes / 1_048_576)}MB`,
      { maxBytes: maxAudioSizeBytes, actualBytes: audioFile.size }
    );
  }

  // Convert audio to base64 for Workers AI Whisper input
  const audioBuffer = await audioFile.arrayBuffer();
  const audioBase64 = arrayBufferToBase64(audioBuffer);
  log.info('audio_converted_to_base64', {
    bufferBytes: audioBuffer.byteLength,
    base64Length: audioBase64.length,
  });

  // Determine model ID (configurable via env var, per Constitution Principle XI)
  const modelId = (c.env.WHISPER_MODEL_ID || DEFAULT_WHISPER_MODEL) as
    '@cf/openai/whisper-large-v3-turbo';
  log.info('calling_workers_ai', { model: modelId });

  // Call Workers AI Whisper model
  let result: { text?: string } | undefined;
  try {
    const aiStartTime = Date.now();
    result = await c.env.AI.run(modelId, {
      audio: audioBase64,
    });
    const aiDurationMs = Date.now() - aiStartTime;
    log.info('workers_ai_response_received', {
      durationMs: aiDurationMs,
      hasResult: !!result,
      hasText: !!result?.text,
      textLength: result?.text?.length ?? 0,
      textPreview: result?.text?.substring(0, 100) ?? '(empty)',
    });
  } catch (aiErr) {
    const totalDurationMs = Date.now() - startTime;
    log.error('workers_ai_call_failed', {
      ...serializeError(aiErr),
      model: modelId,
      audioSizeBytes: audioFile.size,
      totalDurationMs,
    });
    throw aiErr;
  }

  // Extract transcribed text from result
  const text = result?.text ?? '';
  const totalDurationMs = Date.now() - startTime;

  log.info('request_complete', {
    totalDurationMs,
    inputSizeKB: Math.round(audioFile.size / 1024),
    inputType: audioFile.type,
    outputLength: text.trim().length,
    outputText: text.trim().substring(0, 200),
    success: text.trim().length > 0,
  });

  return c.json({ text: text.trim() });
});

export { transcribeRoutes };
