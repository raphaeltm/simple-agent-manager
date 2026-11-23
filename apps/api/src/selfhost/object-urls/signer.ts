/**
 * The box's object URL signer: instead of an S3 presigned URL it returns
 * `https://api.<BASE_DOMAIN>/api/box-objects?token=<token>`, which `route.ts` serves by streaming
 * into or out of the R2 binding. Installed into the shared resolver
 * (`services/r2-s3-client.ts:resolveR2ObjectUrlSigner`) by the self-host build; that resolver
 * still prefers a configured static store key, so a box that has one keeps direct uploads.
 *
 * The token rides in the query string because every client (browser XHR, the vm-agent publisher
 * and builder) PUTs or GETs the URL it is given and sends no SAM credential. Caddy's log redacts
 * every query string (deploy/selfhost/caddy/log-redaction.caddy), SAM's request log records only
 * the path (middleware/request-logging.ts), and celld logs no request URLs at its default level.
 */
import type { ObjectPutUrlOptions, ObjectUrlSigner } from '@simple-agent-manager/app-deployment';

import type { Env } from '../../env';
import { buildTrustedApiUrl } from '../../lib/trusted-origins';
import { errors } from '../../middleware/error';
import { mintBoxObjectToken } from './tokens';

export const BOX_OBJECT_ROUTE = '/api/box-objects';

/**
 * celld v0.6.3 refuses a request body over 1 GiB (413), and refuses to start with
 * CELLD_MAX_REQUEST_BODY_BYTES above it, so no single PUT through a box can be larger. Larger
 * image artifacts need several requests: idea 01M83WWQTNTBD4SY1530G3XWH7 (parted box uploads),
 * which also tracks the 1 GiB artifact cap this imposes on keyless boxes.
 */
export const CELLD_MAX_REQUEST_BODY_BYTES = 1024 * 1024 * 1024;

function owner(options: ObjectPutUrlOptions) {
  const { userId: u, projectId: p, workspaceId: w } = options.owner ?? {};
  return u || p || w ? { u, p, w } : undefined;
}

/** Null when the Worker cannot serve box URLs (no domain, key or R2 binding). */
export function createBoxObjectUrlSigner(env: Env): ObjectUrlSigner | null {
  if (!env.BASE_DOMAIN || !env.ENCRYPTION_KEY || !env.R2) return null;
  const url = (token: string) =>
    `${buildTrustedApiUrl(env, BOX_OBJECT_ROUTE)}?token=${encodeURIComponent(token)}`;
  const max = CELLD_MAX_REQUEST_BODY_BYTES;
  return {
    kind: 'box',
    maxPutBytes: max,
    putUrl: async (r2Key, options) => {
      // The per-uploader slot limit keys on the owner (route.ts): without one, every such upload
      // would share a single bucket and starve the others. Every caller passes one.
      if (!owner(options)) throw new Error(`Box upload URL for ${r2Key} has no owner`);
      if (options.contentLength !== undefined && options.contentLength > max) {
        throw errors.badRequest(
          `Uploads through this self-hosted box are limited to ${max} bytes; this one is ${options.contentLength}`
        );
      }
      const token = await mintBoxObjectToken(env, {
        op: 'put',
        key: r2Key,
        expiresIn: options.expiresIn,
        ...(options.contentLength !== undefined ? { len: options.contentLength } : {}),
        max: Math.min(options.maxBytes ?? max, max),
        ...(options.contentType ? { ct: options.contentType } : {}),
        ...(options.sha256 ? { sha: options.sha256 } : {}),
        ...(options.metadata ? { md: options.metadata } : {}),
        ...(owner(options) ? { sub: owner(options) } : {}),
      });
      return url(token);
    },
    getUrl: async (r2Key, options) =>
      url(await mintBoxObjectToken(env, { op: 'get', key: r2Key, expiresIn: options.expiresIn })),
  };
}
