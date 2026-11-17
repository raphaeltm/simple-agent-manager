import { Hono } from 'hono';

import type { Env } from '../env';
import { applyCacheHeaders } from '../lib/cache-headers';
import { resolvePublicPlatformCapabilities } from '../services/speech-backend';

/**
 * Public config: which platform services this installation has, so the UI can hide entry points
 * that cannot work here (services/platform-capabilities.ts). Booleans only, no auth. On Cloudflare
 * (Workers AI bound) there are no D1, KV or binding calls: the answer is computed from the
 * environment alone. Only a runtime without Workers AI that installed a speech backend
 * (services/speech-backend.ts) reads that backend's settings.
 */
export const platformCapabilitiesRoutes = new Hono<{ Bindings: Env }>();

platformCapabilitiesRoutes.get('/platform-capabilities', async (c) => {
  applyCacheHeaders(c, 'public-config');
  return c.json(await resolvePublicPlatformCapabilities(c.env));
});
