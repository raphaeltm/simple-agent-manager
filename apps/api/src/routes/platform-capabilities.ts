import { Hono } from 'hono';

import type { Env } from '../env';
import { applyCacheHeaders } from '../lib/cache-headers';
import { publicPlatformCapabilities } from '../services/platform-capabilities';

/**
 * Public config: which platform services this installation has, so the UI can hide entry points
 * that cannot work here (services/platform-capabilities.ts). Booleans only, no auth, and no D1,
 * KV or binding calls: the answer is computed from the environment alone.
 */
export const platformCapabilitiesRoutes = new Hono<{ Bindings: Env }>();

platformCapabilitiesRoutes.get('/platform-capabilities', (c) => {
  applyCacheHeaders(c, 'public-config');
  return c.json(publicPlatformCapabilities(c.env));
});
