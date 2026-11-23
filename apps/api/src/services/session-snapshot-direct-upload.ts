import { PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import type { Env } from '../env';
import { parsePositiveInt } from '../lib/route-helpers';
import {
  getR2PresignTarget,
  r2ObjectUrlsAvailable,
  resolveR2ObjectUrlSigner,
} from './r2-s3-client';

export const DEFAULT_SESSION_SNAPSHOT_UPLOAD_URL_TTL_SECONDS = 15 * 60;

/**
 * Direct uploads need a URL signer: R2 presign (Cloudflare, or an operator store with a key), or
 * on a self-hosted box its own upload route. A box needs the second: the Worker-streamed fallback
 * route reads `X-SAM-Content-SHA256`, which the box's Caddy strips from every client request.
 */
export function sessionSnapshotDirectUploadAvailable(env: Env): boolean {
  return r2ObjectUrlsAvailable(env);
}

function checksumBase64(checksumHex: string): string {
  const bytes = Uint8Array.from(checksumHex.match(/.{2}/g) ?? [], (value) =>
    Number.parseInt(value, 16)
  );
  return btoa(String.fromCharCode(...bytes));
}

export async function generateSessionSnapshotDirectUploadUrl(
  env: Env,
  input: {
    key: string;
    sizeBytes: number;
    sha256: string;
    contentType: string;
    checksumHeader?: boolean;
  }
): Promise<string> {
  const expiresIn = parsePositiveInt(
    env.SESSION_SNAPSHOT_UPLOAD_URL_TTL_SECONDS,
    DEFAULT_SESSION_SNAPSHOT_UPLOAD_URL_TTL_SECONDS
  );
  const signer = resolveR2ObjectUrlSigner(env);
  if (signer?.kind === 'box') {
    // The box verifies the digest itself (R2 put `sha256`), so no checksum header is signed.
    return signer.putUrl(input.key, {
      expiresIn,
      contentLength: input.sizeBytes,
      contentType: input.contentType,
      sha256: input.sha256,
    });
  }
  // Presign: unchanged (pinned by r2-presign-cloudflare-equivalence.test.ts).
  const target = getR2PresignTarget(env);
  const command = new PutObjectCommand({
    Bucket: target.bucket,
    Key: target.objectKey(input.key),
    ContentLength: input.sizeBytes,
    ContentType: input.contentType,
    ChecksumSHA256: checksumBase64(input.sha256),
  });
  return getSignedUrl(target.client, command, {
    expiresIn,
    ...(input.checksumHeader ? { unhoistableHeaders: new Set(['x-amz-checksum-sha256']) } : {}),
  });
}
