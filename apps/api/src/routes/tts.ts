import { Hono } from 'hono';

import type { Env } from '../env';
import { log } from '../lib/logger';
import { getAuth, requireApproved,requireAuth } from '../middleware/auth';
import { errors } from '../middleware/error';
import { parseOptionalBody, TtsRequestSchema } from '../schemas';
import { getAudioFromR2, getTTSConfig,synthesizeSpeech } from '../services/tts';

const ttsRoutes = new Hono<{ Bindings: Env }>();

// Auth required for all TTS routes
ttsRoutes.use('*', requireAuth(), requireApproved());

/**
 * POST /api/tts/synthesize
 *
 * Generates TTS audio from text. If audio for this storageId already exists
 * in R2, returns the cached version. Otherwise: LLM cleanup → chunk → TTS → R2 store.
 *
 * For long text, automatically chunks at sentence boundaries and concatenates audio.
 * For very long text (above summary threshold), summarizes via LLM first.
 *
 * Request body: { text: string, storageId: string, mode?: "full" | "summary" }
 * Response: { audioUrl: string, cached: boolean, summarized: boolean }
 */
ttsRoutes.post('/synthesize', async (c) => {
  const auth = getAuth(c);
  const userId = auth.user.id;
  const config = getTTSConfig(c.env);

  if (!config.enabled) {
    throw errors.badRequest('Text-to-speech is disabled');
  }

  const body = await parseOptionalBody(c.req.raw, TtsRequestSchema, {});
  if (!body.text || !body.storageId) {
    throw errors.badRequest('Missing required fields: text, storageId');
  }

  const { text, storageId, mode } = body;

  // Validate storageId format (alphanumeric, hyphens, underscores — prevent path traversal)
  if (!/^[a-zA-Z0-9_-]+$/.test(storageId)) {
    throw errors.badRequest('Invalid storageId format');
  }

  if (text.length === 0) {
    throw errors.badRequest('Text cannot be empty');
  }

  try {
    const result = await synthesizeSpeech(text, storageId, c.env.AI, c.env.R2, config, userId, mode);

    // Return the audio URL for the client to fetch
    return c.json({
      audioUrl: `/api/tts/audio/${storageId}`,
      cached: result.cached,
      summarized: result.summarized,
    });
  } catch (err) {
    log.error('tts.synthesize_failed', {
      error: err instanceof Error ? err.message : String(err),
      storageId,
      textLength: text.length,
      mode,
    });
    const errorMessage = err instanceof Error ? err.message : String(err);
    throw errors.internal(`TTS synthesis failed: ${errorMessage}`);
  }
});

/**
 * GET /api/tts/audio/:storageId
 *
 * Serves cached TTS audio from R2. Returns 404 if the audio hasn't been generated yet.
 * The client should call POST /synthesize first, then use this URL for playback.
 */
ttsRoutes.get('/audio/:storageId', async (c) => {
  const auth = getAuth(c);
  const userId = auth.user.id;
  const { storageId } = c.req.param();
  const config = getTTSConfig(c.env);

  // Validate storageId format
  if (!/^[a-zA-Z0-9_-]+$/.test(storageId)) {
    throw errors.badRequest('Invalid storageId format');
  }

  const audioObject = await getAudioFromR2(c.env.R2, storageId, userId, config);
  if (!audioObject) {
    throw errors.notFound('Audio not found');
  }

  // Read content type from R2 metadata (set at store time), fallback to audio/mpeg
  const contentType = audioObject.httpMetadata?.contentType ?? 'audio/mpeg';

  return new Response(audioObject.body, {
    headers: {
      'Content-Type': contentType,
      'Cache-Control': 'private, max-age=86400',
      'Content-Length': String(audioObject.size),
    },
  });
});

export { ttsRoutes };
