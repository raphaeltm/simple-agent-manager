import { Hono } from 'hono';

import type { Env } from '../env';
import { applyCacheHeaders } from '../lib/cache-headers';
import { isArtifactsAvailable } from '../services/hosted-git/backend';

/**
 * Public config: whether this install can create SAM-native (Artifacts) repositories. True only
 * when ARTIFACTS_ENABLED is set and a backend exists (the Cloudflare binding, or the backend a
 * self-host build registered), so the UI never offers a provider that would fail on use.
 */
export const artifactsConfigRoutes = new Hono<{ Bindings: Env }>();

artifactsConfigRoutes.get('/artifacts-enabled', (c) => {
  applyCacheHeaders(c, 'public-config');
  return c.json({ enabled: isArtifactsAvailable(c.env) });
});
