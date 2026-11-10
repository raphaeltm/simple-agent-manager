/**
 * Where presigned S3 URLs for R2 objects point. No SDK import, so the capability resolver can
 * use it cheaply; `r2-s3-client.ts` builds the client from it.
 *
 * Cloudflare (default): `https://<CF_ACCOUNT_ID>.r2.cloudflarestorage.com`, bucket
 * `R2_BUCKET_NAME`, object key = the R2 key.
 *
 * Operator store (`R2_S3_ENDPOINT` set): a runtime such as celld keeps the R2 binding's objects
 * in its own S3 bucket under a prefix, for example `r2/<bucket_name>/<key>` in the fleet bucket.
 * Presigned URLs then target `R2_S3_BUCKET` at `${R2_S3_KEY_PREFIX}${key}`, so the binding and
 * the URL address the same object. `R2_ACCESS_KEY_ID`/`R2_SECRET_ACCESS_KEY` must be a credential
 * limited to that prefix, never the fleet credential: the fleet bucket also holds deploy
 * manifests with plaintext secrets.
 */
import type { Env } from '../env';
import { isAcceptableOperatorEndpoint } from '../lib/network-hosts';

/** Cloudflare R2's S3 API ignores the region; SigV4 still needs one. */
const DEFAULT_R2_S3_REGION = 'auto';

export interface R2PresignConfig {
  endpoint: string;
  bucket: string;
  /** Prepended to every R2 key. Empty on Cloudflare. */
  keyPrefix: string;
  region: string;
  /** Path-style (`/<bucket>/<key>`) addressing; undefined keeps the SDK default. */
  forcePathStyle: boolean | undefined;
  accessKeyId: string;
  secretAccessKey: string;
}

type R2PresignEnv = Pick<
  Env,
  | 'CF_ACCOUNT_ID'
  | 'R2_ACCESS_KEY_ID'
  | 'R2_SECRET_ACCESS_KEY'
  | 'R2_BUCKET_NAME'
  | 'R2_S3_ENDPOINT'
  | 'R2_S3_BUCKET'
  | 'R2_S3_KEY_PREFIX'
  | 'R2_S3_REGION'
  | 'R2_S3_FORCE_PATH_STYLE'
>;

function text(value: string | undefined): string {
  return value?.trim() ?? '';
}

function validEndpoint(value: string): boolean {
  try {
    return isAcceptableOperatorEndpoint(new URL(value));
  } catch {
    return false;
  }
}

/** True when any path segment could resolve outside its parent or confuse a gateway. */
function hasUnsafeKeySegment(value: string): boolean {
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is refused
  if (value.startsWith('/') || value.includes('\\') || /[\u0000-\u001f\u007f]/.test(value))
    return true;
  return value.split('/').some((segment) => segment === '.' || segment === '..');
}

/**
 * A relative key prefix that ends in `/` (so `r2/<bucket>/` cannot glue onto the key) and has
 * no empty, `.` or `..` segment, so it cannot escape its scope.
 */
function validKeyPrefix(value: string): boolean {
  return (
    value.endsWith('/') &&
    !hasUnsafeKeySegment(value) &&
    !value.slice(0, -1).split('/').some((segment) => segment === '')
  );
}

/** Operator-store settings that mean nothing without R2_S3_ENDPOINT. */
const OPERATOR_STORE_ONLY_VARS = [
  'R2_S3_BUCKET',
  'R2_S3_KEY_PREFIX',
  'R2_S3_REGION',
  'R2_S3_FORCE_PATH_STYLE',
] as const;

/**
 * The presign target, or null when presigning is not configured. A partially configured
 * operator store (endpoint without bucket or prefix, or an invalid one) is null too: it must
 * never fall back to Cloudflare with keys meant for another store.
 */
export function resolveR2PresignConfig(env: R2PresignEnv): R2PresignConfig | null {
  const accessKeyId = text(env.R2_ACCESS_KEY_ID);
  const secretAccessKey = text(env.R2_SECRET_ACCESS_KEY);
  if (!accessKeyId || !secretAccessKey) return null;

  const endpoint = text(env.R2_S3_ENDPOINT);
  // A store setting without its endpoint is a misconfiguration, not "use Cloudflare": signing
  // for R2 with an operator's key would put objects where the binding never reads them.
  if (!endpoint && OPERATOR_STORE_ONLY_VARS.some((name) => text(env[name]))) return null;
  if (endpoint) {
    const bucket = text(env.R2_S3_BUCKET);
    const keyPrefix = text(env.R2_S3_KEY_PREFIX);
    if (!validEndpoint(endpoint) || !bucket || !validKeyPrefix(keyPrefix)) return null;
    return {
      endpoint: endpoint.replace(/\/+$/, ''),
      bucket,
      keyPrefix,
      region: text(env.R2_S3_REGION) || DEFAULT_R2_S3_REGION,
      // Self-hosted stores (MinIO, SeaweedFS) are addressed by path; opt out with "false".
      forcePathStyle: text(env.R2_S3_FORCE_PATH_STYLE).toLowerCase() !== 'false',
      accessKeyId,
      secretAccessKey,
    };
  }

  const accountId = text(env.CF_ACCOUNT_ID);
  const bucket = text(env.R2_BUCKET_NAME);
  if (!accountId || !bucket) return null;
  return {
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    bucket,
    keyPrefix: '',
    region: DEFAULT_R2_S3_REGION,
    forcePathStyle: undefined,
    accessKeyId,
    secretAccessKey,
  };
}

/**
 * The store key for an R2 key: where the R2 binding keeps that object. Under an operator prefix
 * the key must not be able to climb out of it (a gateway that normalises `..` would otherwise
 * sign a URL outside the prefix, toward the fleet bucket's secrets). On Cloudflare (no prefix)
 * keys are opaque object names and pass through unchanged.
 */
export function r2PresignObjectKey(config: R2PresignConfig, r2Key: string): string {
  if (config.keyPrefix && hasUnsafeKeySegment(r2Key)) {
    throw new Error('R2 object key has an unsafe path segment');
  }
  return `${config.keyPrefix}${r2Key}`;
}
