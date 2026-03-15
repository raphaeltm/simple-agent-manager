import { Hono } from 'hono';
import type { Env } from '../index';
import { requireAuth, requireApproved } from '../middleware/auth';
import { errors } from '../middleware/error';
import { synthesizeSpeech, getAudioFromR2, getTTSConfig } from '../services/tts';
import { log } from '../lib/logger';

const ttsRoutes = new Hono<{ Bindings: Env }>();

// Auth required for all TTS routes
ttsRoutes.use('*', requireAuth(), requireApproved());

/**
 * POST /api/tts/synthesize
 *
 * Generates TTS audio from text. If audio for this storageId already exists
 * in R2, returns the cached version. Otherwise: LLM markdown cleanup → TTS → R2 store.
 *
 * Request body: { text: string, storageId: string }
 * Response: { audioUrl: string, cached: boolean }
 */
ttsRoutes.post('/synthesize', async (c) => {
  const config = getTTSConfig(c.env);

  if (!config.enabled) {
    throw errors.badRequest('Text-to-speech is disabled');
  }

  const body = await c.req.json<{ text?: string; storageId?: string }>().catch(() => null);
  if (!body?.text || !body?.storageId) {
    throw errors.badRequest('Missing required fields: text, storageId');
  }

  const { text, storageId } = body;

  // Validate storageId format (alphanumeric, hyphens, underscores — prevent path traversal)
  if (!/^[a-zA-Z0-9_-]+$/.test(storageId)) {
    throw errors.badRequest('Invalid storageId format');
  }

  if (text.length === 0) {
    throw errors.badRequest('Text cannot be empty');
  }

  try {
    const result = await synthesizeSpeech(text, storageId, c.env.AI, c.env.R2, config);

    // Return the audio URL for the client to fetch
    return c.json({
      audioUrl: `/api/tts/audio/${storageId}`,
      cached: result.cached,
    });
  } catch (err) {
    log.error('tts.synthesize_failed', {
      error: err instanceof Error ? err.message : String(err),
      storageId,
      textLength: text.length,
    });
    throw errors.internal('Failed to generate audio');
  }
});

/**
 * GET /api/tts/audio/:storageId
 *
 * Serves cached TTS audio from R2. Returns 404 if the audio hasn't been generated yet.
 * The client should call POST /synthesize first, then use this URL for playback.
 */
ttsRoutes.get('/audio/:storageId', async (c) => {
  const { storageId } = c.req.param();
  const config = getTTSConfig(c.env);

  // Validate storageId format
  if (!/^[a-zA-Z0-9_-]+$/.test(storageId)) {
    throw errors.badRequest('Invalid storageId format');
  }

  const audioObject = await getAudioFromR2(c.env.R2, storageId, config);
  if (!audioObject) {
    throw errors.notFound('Audio not found');
  }

  // Read content type from R2 metadata (set at store time), fallback to audio/mpeg
  const contentType = audioObject.httpMetadata?.contentType ?? 'audio/mpeg';

  return new Response(audioObject.body, {
    headers: {
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=86400',
      'Content-Length': String(audioObject.size),
    },
  });
});

export { ttsRoutes };
