/**
 * The sealed secrets bundle: every Worker secret of a self-hosted install in one file of
 * ciphertext. A fresh random data key encrypts the secrets (AES-256-GCM, the header as AAD); the
 * key service wraps that data key with its KEK, using the same header as its context where it
 * supports one. Without the key service the file is useless, which is what lets it sit in
 * `.state/`, in backups and anywhere else.
 *
 * Every seal draws a new data key and a new bundle id, so rotating the data key, rotating the
 * KEK and moving to another provider are all "open, then seal again".
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import { b64, type KeyProvider, KeyProviderError, unb64 } from './provider.ts';

export const BUNDLE_FORMAT = 'sam-sealed-secrets/1';
/** A bundle id: 128 random bits, hex. Also the bundle's file name, so it must stay this shape. */
export const BUNDLE_ID = /^[0-9a-f]{32}$/;
const SECRET_NAME = /^[A-Z_][A-Z0-9_]*$/;
const IV_BYTES = 12;
const TAG_BYTES = 16;
/** Bound on the decrypted payload (PEM keys included, a box needs a few KiB). */
export const MAX_SECRETS_BYTES = 256 * 1024;

export interface SealedBundle {
  format: typeof BUNDLE_FORMAT;
  bundleId: string;
  installationId: string;
  createdAt: string;
  provider: string;
  keyRef: string;
  /** Opaque to SAM; only the provider that made it can unwrap it. */
  wrappedKey: string;
  iv: string;
  /** AES-256-GCM over the JSON secrets object, tag appended. */
  ciphertext: string;
}

export type Secrets = Record<string, string>;

/** The authenticated header: everything but the key material, in a fixed order. */
export function headerBytes(b: Pick<SealedBundle, 'format' | 'bundleId' | 'installationId' | 'createdAt' | 'provider' | 'keyRef'>): Uint8Array {
  return new Uint8Array(
    Buffer.from(
      JSON.stringify([b.format, b.bundleId, b.installationId, b.createdAt, b.provider, b.keyRef]),
      'utf8'
    )
  );
}

function assertSecrets(secrets: unknown): asserts secrets is Secrets {
  if (typeof secrets !== 'object' || secrets === null || Array.isArray(secrets)) {
    throw new KeyProviderError('invalid', 'bundle secrets must be an object');
  }
  for (const [name, value] of Object.entries(secrets)) {
    if (!SECRET_NAME.test(name) || typeof value !== 'string') {
      throw new KeyProviderError('invalid', 'bundle secrets must map UPPER_SNAKE_CASE names to strings');
    }
  }
}

export interface SealOptions {
  installationId: string;
  now?: () => Date;
}

export async function sealSecrets(
  secrets: Secrets,
  provider: KeyProvider,
  options: SealOptions
): Promise<SealedBundle> {
  assertSecrets(secrets);
  const sorted = Object.fromEntries(Object.entries(secrets).sort(([a], [b]) => (a < b ? -1 : 1)));
  const plaintext = Buffer.from(JSON.stringify(sorted), 'utf8');
  if (plaintext.length > MAX_SECRETS_BYTES) {
    throw new KeyProviderError('invalid', `secrets exceed ${MAX_SECRETS_BYTES} bytes`);
  }
  const header = {
    format: BUNDLE_FORMAT,
    bundleId: randomBytes(16).toString('hex'),
    installationId: options.installationId,
    createdAt: (options.now?.() ?? new Date()).toISOString(),
    provider: provider.name,
    keyRef: provider.keyRef,
  } as const;
  const aad = headerBytes(header);
  const dataKey = randomBytes(32);
  try {
    const wrapped = await provider.wrap(new Uint8Array(dataKey), aad);
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', dataKey, iv);
    cipher.setAAD(aad);
    const body = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
    return { ...header, wrappedKey: b64(wrapped), iv: b64(iv), ciphertext: b64(body) };
  } finally {
    dataKey.fill(0);
    plaintext.fill(0);
  }
}

const FIELDS = [
  'format',
  'bundleId',
  'installationId',
  'createdAt',
  'provider',
  'keyRef',
  'wrappedKey',
  'iv',
  'ciphertext',
] as const;

/** Strict shape check of a bundle file; never echoes field values in errors. */
export function parseBundle(text: string): SealedBundle {
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    throw new KeyProviderError('invalid', 'bundle is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new KeyProviderError('invalid', 'bundle is not an object');
  }
  const record = raw as Record<string, unknown>;
  const extra = Object.keys(record).filter((k) => !(FIELDS as readonly string[]).includes(k));
  if (extra.length > 0) throw new KeyProviderError('invalid', 'bundle has unknown fields');
  for (const name of FIELDS) {
    if (typeof record[name] !== 'string' || record[name] === '') {
      throw new KeyProviderError('invalid', `bundle field ${name} is missing`);
    }
  }
  if (record.format !== BUNDLE_FORMAT) {
    throw new KeyProviderError('invalid', 'bundle format is not supported');
  }
  if (!BUNDLE_ID.test(record.bundleId as string)) {
    throw new KeyProviderError('invalid', 'bundle id is malformed');
  }
  return record as unknown as SealedBundle;
}

/**
 * Opens a bundle with the configured provider. A bundle sealed by a different provider or KEK
 * is refused before any key-service call, so the box never sends a blob to the wrong service.
 */
export async function openBundle(bundle: SealedBundle, provider: KeyProvider): Promise<Secrets> {
  if (bundle.provider !== provider.name || bundle.keyRef !== provider.keyRef) {
    throw new KeyProviderError(
      'config',
      `bundle ${bundle.bundleId} was sealed with ${bundle.provider} key ${bundle.keyRef}, ` +
        `but this box is configured for ${provider.name} key ${provider.keyRef}`
    );
  }
  const aad = headerBytes(bundle);
  const dataKey = Buffer.from(await provider.unwrap(unb64(bundle.wrappedKey, 'wrappedKey'), aad));
  try {
    if (dataKey.length !== 32) throw new KeyProviderError('invalid', 'unwrapped data key has the wrong size');
    const iv = Buffer.from(unb64(bundle.iv, 'iv'));
    const body = Buffer.from(unb64(bundle.ciphertext, 'ciphertext'));
    if (iv.length !== IV_BYTES || body.length < TAG_BYTES) {
      throw new KeyProviderError('invalid', 'bundle ciphertext is malformed');
    }
    let plaintext: Buffer;
    try {
      const decipher = createDecipheriv('aes-256-gcm', dataKey, iv);
      decipher.setAAD(aad);
      decipher.setAuthTag(body.subarray(body.length - TAG_BYTES));
      plaintext = Buffer.concat([decipher.update(body.subarray(0, body.length - TAG_BYTES)), decipher.final()]);
    } catch {
      throw new KeyProviderError('invalid', 'bundle does not verify (tampered, or another data key)');
    }
    try {
      if (plaintext.length > MAX_SECRETS_BYTES) throw new KeyProviderError('invalid', 'bundle is too large');
      const secrets = JSON.parse(plaintext.toString('utf8')) as unknown;
      assertSecrets(secrets);
      return secrets;
    } finally {
      plaintext.fill(0);
    }
  } finally {
    dataKey.fill(0);
  }
}
