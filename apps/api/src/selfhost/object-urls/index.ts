/**
 * Box object URLs for the self-host build: uploads and downloads that go through the box instead
 * of S3 presigned URLs, for a box with no static store key (task
 * tasks/active/2026-11-23-selfhost-box-object-uploads.md).
 *
 * Only `selfhost/build.ts` imports this module, so the Cloudflare bundle carries none of it and
 * keeps minting R2 presigned URLs (tests/unit/selfhost/selfhost-only-modules.test.ts).
 */
import type { Hono } from 'hono';

import type { Env } from '../../env';
import { installAdminSettingDefinitions } from '../../services/admin-settings-registry';
import { installBoxObjectUrlSigner } from '../../services/r2-s3-client';
import { handleBoxObjectRequest } from './route';
import { BOX_OBJECT_SETTINGS } from './settings';
import { BOX_OBJECT_ROUTE, createBoxObjectUrlSigner } from './signer';

export { BoxUploadGate } from './gate';

/** Registers the signer and settings (idempotent). */
export function installBoxObjectUrls(): void {
  installAdminSettingDefinitions(BOX_OBJECT_SETTINGS);
  installBoxObjectUrlSigner(createBoxObjectUrlSigner);
}

/**
 * Mounts the route. Call once, after `src/index.ts` registered the shared routes: like hosted git's
 * route, it then runs after exactly the global middleware (request logging, CORS) and no
 * session-auth middleware, which it must not have (the token is the credential).
 */
export function mountBoxObjectRoute(app: Hono<{ Bindings: Env }>): void {
  app.on(['PUT', 'GET'], BOX_OBJECT_ROUTE, (c) => handleBoxObjectRequest(c));
}
