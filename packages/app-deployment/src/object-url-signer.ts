import type { S3Client } from '@aws-sdk/client-s3';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

/**
 * Where a client sends an object's bytes, or fetches them, without holding a SAM credential: the
 * one seam behind compose image artifacts, build contexts and task attachments.
 *
 * - `presign`: an S3 presigned URL straight to the store (Cloudflare R2, or an operator store with
 *   a static key). `s3ObjectUrlSigner` below; the Cloudflare URLs it produces are pinned
 *   byte-for-byte by apps/api/tests/unit/services/r2-presign-cloudflare-equivalence.test.ts.
 * - `box`: a SAM-signed token URL that a self-hosted box streams into its R2 binding
 *   (apps/api/src/selfhost/object-urls/). Installed only by the self-host build.
 *
 * The worker chooses one per request (`apps/api/src/services/r2-s3-client.ts`,
 * `getR2ObjectUrlSigner`); this package never resolves credentials itself.
 */
export interface ObjectPutUrlOptions {
  /** Seconds the URL stays valid. */
  expiresIn: number;
  contentType?: string;
  /** Exact body length the client will send; signed into the URL when given. */
  contentLength?: number;
  /** Largest body the client may send when the length is not known in advance (box only). */
  maxBytes?: number;
  /** Custom metadata stored with the object; S3 signs each `x-amz-meta-*` header. */
  metadata?: Record<string, string>;
  /** Hex sha256 the body must have; the box verifies it while writing. */
  sha256?: string;
  /** Who asked, for the box route's logs. */
  owner?: { userId?: string; projectId?: string; workspaceId?: string };
}

export interface ObjectUrlSigner {
  readonly kind: 'presign' | 'box';
  /** Largest body one PUT can carry through this signer; undefined when it adds no bound. */
  readonly maxPutBytes?: number;
  putUrl(r2Key: string, options: ObjectPutUrlOptions): Promise<string>;
  getUrl(r2Key: string, options: { expiresIn: number }): Promise<string>;
}

/** The worker's shared R2 S3 client and the store object a binding key maps to. */
export interface S3PresignTarget {
  client: S3Client;
  /** S3 bucket the URL addresses. */
  bucket: string;
  /** S3 object key for an R2 key (prefix applied for operator stores). */
  objectKey(r2Key: string): string;
}

/**
 * Presigned S3 URLs. `maxBytes`, `sha256` and `owner` have no S3 form and are not signed: a
 * presigned PUT is bounded by `contentLength` when given, and callers validate the stored object
 * (size, recorded metadata) before using it, as they always have.
 */
export function s3ObjectUrlSigner(target: S3PresignTarget): ObjectUrlSigner {
  return {
    kind: 'presign',
    putUrl: (r2Key, options) => {
      const metadataHeaders = Object.keys(options.metadata ?? {}).map(
        (name) => `x-amz-meta-${name}`
      );
      return getSignedUrl(
        target.client,
        new PutObjectCommand({
          Bucket: target.bucket,
          Key: target.objectKey(r2Key),
          ...(options.contentLength === undefined ? {} : { ContentLength: options.contentLength }),
          ...(options.contentType === undefined ? {} : { ContentType: options.contentType }),
          ...(options.metadata ? { Metadata: options.metadata } : {}),
        }),
        {
          expiresIn: options.expiresIn,
          // The uploader sends metadata as headers. Keep them in SignedHeaders instead of hoisting
          // them into the query, so a changed value (a different digest) invalidates the PUT.
          ...(metadataHeaders.length > 0 ? { unhoistableHeaders: new Set(metadataHeaders) } : {}),
        }
      );
    },
    getUrl: (r2Key, options) =>
      getSignedUrl(
        target.client,
        new GetObjectCommand({ Bucket: target.bucket, Key: target.objectKey(r2Key) }),
        { expiresIn: options.expiresIn }
      ),
  };
}
