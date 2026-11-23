/**
 * Tokens for box object URLs: one object key, one operation, a size bound and a short expiry,
 * signed by the Worker itself (`../signed-token.ts`, its own HKDF label). They stand in for S3
 * presigned URLs on a box that has no static store credential: the uploader PUTs (or the
 * downloader GETs) `https://api.<domain>/api/self-host/objects?token=...` and `route.ts` streams the
 * body to or from the R2 binding.
 *
 * Who a token acts for is decided before it is minted: only the authenticated routes that already
 * minted presigned URLs mint these (attachments `request-upload`, compose image artifact init and
 * release, build-context init and job spec), and they derive the key from the caller's verified
 * identity. The key travels only inside the signed payload, never as a request parameter.
 *
 * Rotation: signing uses ENCRYPTION_KEY; verification also accepts ENCRYPTION_KEY_PREVIOUS, so a
 * token minted minutes before `selfhost:secrets rotate` switches keys still works while the
 * rotation overlaps. Once the previous key is dropped, such a token fails with 403 and the uploader
 * asks for a new one, exactly as an expired presigned URL would.
 */
import { BUILD_CONTEXT_PREFIX } from '@simple-agent-manager/app-deployment';

import {
  MAX_SIGNED_TOKEN_LENGTH,
  mintSignedToken,
  type SignedTokenEnv,
  verifySignedToken,
} from '../signed-token';

export type BoxObjectOperation = 'put' | 'get';

export interface BoxObjectTokenClaims {
  /** Token format version. */
  v: 1;
  op: BoxObjectOperation;
  /** R2 binding key. */
  key: string;
  /** Expiry, unix seconds. */
  exp: number;
  /** PUT: the exact body length the uploader declared, when it declared one. */
  len?: number;
  /** PUT: largest body accepted. */
  max?: number;
  /** PUT: Content-Type stored on the object. */
  ct?: string;
  /** PUT: hex sha256 the body must have (R2 verifies it while writing). */
  sha?: string;
  /** PUT: custom metadata stored on the object. */
  md?: Record<string, string>;
  /** Who asked for the token, for logs only: user, project and workspace ids. */
  sub?: { u?: string; p?: string; w?: string };
}

const PURPOSE = {
  prefix: 'samobj1',
  label: 'sam-box-object-url/v1',
  acceptPreviousKey: true,
} as const;

/**
 * The only key prefixes a token may name: task attachments (`attachment-upload.ts`
 * buildAttachmentR2Key), compose image artifacts (`buildComposeImageArtifactKey`) and build
 * contexts (`buildContextKey`). The R2 binding also holds vm-agent binaries and session snapshots,
 * so a minting bug must not be able to reach them. Enforced at mint and at verify.
 */
export const BOX_OBJECT_KEY_PREFIXES: readonly string[] = [
  'temp-uploads/',
  'compose-image-artifacts/',
  BUILD_CONTEXT_PREFIX,
];

/** Longest lifetime a token may have, whatever the minting route asked for. */
export const MAX_BOX_OBJECT_TOKEN_SECONDS = 24 * 60 * 60;

/** Longest key accepted; R2 allows 1024 bytes. */
const MAX_KEY_LENGTH = 1024;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const MAX_METADATA_ENTRIES = 8;
const MAX_METADATA_VALUE_LENGTH = 256;

/**
 * An R2 key a token may name: under one of BOX_OBJECT_KEY_PREFIXES, relative, no empty, `.` or
 * `..` segment, no backslash or control character. Keys SAM builds always pass; anything else is
 * refused at mint and at verify.
 */
export function isSafeObjectKey(key: string): boolean {
  if (!key || key.length > MAX_KEY_LENGTH) return false;
  if (!BOX_OBJECT_KEY_PREFIXES.some((prefix) => key.startsWith(prefix))) return false;
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is refused
  if (key.startsWith('/') || key.includes('\\') || /[\u0000-\u001f\u007f]/.test(key)) return false;
  return key.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  return (
    entries.length <= MAX_METADATA_ENTRIES &&
    entries.every(
      ([name, item]) =>
        /^[a-z0-9-]{1,64}$/.test(name) &&
        typeof item === 'string' &&
        item.length <= MAX_METADATA_VALUE_LENGTH
    )
  );
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function optionalId(value: unknown): value is string | undefined {
  return value === undefined || (typeof value === 'string' && value.length <= 128);
}

/** The claims if they are well formed; null otherwise. */
function parseClaims(raw: Record<string, unknown>): BoxObjectTokenClaims | null {
  if (raw.v !== 1 || (raw.op !== 'put' && raw.op !== 'get')) return null;
  if (typeof raw.key !== 'string' || !isSafeObjectKey(raw.key)) return null;
  if (!positiveInteger(raw.exp)) return null;
  if (raw.len !== undefined && !positiveInteger(raw.len)) return null;
  if (raw.max !== undefined && !positiveInteger(raw.max)) return null;
  if (raw.ct !== undefined && (typeof raw.ct !== 'string' || raw.ct.length > 255)) return null;
  if (raw.sha !== undefined && (typeof raw.sha !== 'string' || !SHA256_HEX.test(raw.sha)))
    return null;
  if (raw.md !== undefined && !isStringRecord(raw.md)) return null;
  // A PUT is always bounded: by its declared length, its maximum, or both.
  if (raw.op === 'put' && raw.len === undefined && raw.max === undefined) return null;
  if (raw.op === 'get' && (raw.len ?? raw.max ?? raw.ct ?? raw.sha ?? raw.md) !== undefined)
    return null;
  let sub: BoxObjectTokenClaims['sub'];
  if (raw.sub !== undefined) {
    if (!raw.sub || typeof raw.sub !== 'object' || Array.isArray(raw.sub)) return null;
    const { u, p, w } = raw.sub as Record<string, unknown>;
    if (!optionalId(u) || !optionalId(p) || !optionalId(w)) return null;
    sub = { ...(u ? { u } : {}), ...(p ? { p } : {}), ...(w ? { w } : {}) };
  }
  return {
    v: 1,
    op: raw.op,
    key: raw.key,
    exp: raw.exp,
    ...(raw.len !== undefined ? { len: raw.len as number } : {}),
    ...(raw.max !== undefined ? { max: raw.max as number } : {}),
    ...(raw.ct !== undefined ? { ct: raw.ct as string } : {}),
    ...(raw.sha !== undefined ? { sha: raw.sha as string } : {}),
    ...(raw.md !== undefined ? { md: raw.md as Record<string, string> } : {}),
    ...(sub ? { sub } : {}),
  };
}

export type BoxObjectTokenInput = Omit<BoxObjectTokenClaims, 'v' | 'exp'> & {
  /** Seconds the token stays valid. */
  expiresIn: number;
};

export async function mintBoxObjectToken(
  env: Pick<SignedTokenEnv, 'ENCRYPTION_KEY'>,
  input: BoxObjectTokenInput,
  now: number = Date.now()
): Promise<string> {
  const { expiresIn, ...rest } = input;
  if (!positiveInteger(expiresIn) || expiresIn > MAX_BOX_OBJECT_TOKEN_SECONDS) {
    throw new Error(`Box object token lifetime must be 1..${MAX_BOX_OBJECT_TOKEN_SECONDS} seconds`);
  }
  const claims = parseClaims({ ...rest, v: 1, exp: Math.floor(now / 1000) + expiresIn });
  if (!claims) throw new Error('Box object token claims are invalid');
  const token = await mintSignedToken(env, PURPOSE, claims);
  // Verification refuses longer tokens; fail here instead of handing out a URL that cannot work.
  if (token.length > MAX_SIGNED_TOKEN_LENGTH) throw new Error('Box object token is too long');
  return token;
}

/** Signature, shape and expiry. Null for any token that is not valid now. */
export async function verifyBoxObjectToken(
  env: SignedTokenEnv,
  token: string,
  now: number = Date.now()
): Promise<BoxObjectTokenClaims | null> {
  const raw = await verifySignedToken(env, PURPOSE, token);
  const claims = raw ? parseClaims(raw) : null;
  if (!claims || claims.exp * 1000 <= now) return null;
  // A token valid for longer than any minter may issue is not one SAM minted correctly.
  if (claims.exp * 1000 - now > MAX_BOX_OBJECT_TOKEN_SECONDS * 1000) return null;
  return claims;
}
