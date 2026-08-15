const P256_PUBLIC_KEY_BYTES = 65;
const P256_PRIVATE_KEY_BYTES = 32;
const AUTH_SECRET_BYTES = 16;
const SALT_BYTES = 16;
const AES_128_GCM_KEY_BYTES = 16;
const NONCE_BYTES = 12;
const RECORD_SIZE = 4096;
const MAX_VAPID_TTL_SECONDS = 24 * 60 * 60;

const encoder = new TextEncoder();

export interface WebPushSubscriptionKeys {
  p256dh: string;
  auth: string;
}

export interface WebPushSubscription extends WebPushSubscriptionKeys {
  endpoint: string;
}

export interface VapidKeyMaterial {
  publicKey: string;
  privateKey: string;
  subject: string;
}

export interface WebPushEncryptionOptions {
  salt?: string;
  senderPrivateKey?: string;
  senderPublicKey?: string;
}

export interface VapidAuthorizationOptions {
  now?: Date;
  ttlSeconds?: number;
}

/** Decode an unpadded base64url value without relying on Node-only Buffer. */
export function decodeBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error('Invalid base64url value');
  }
  const padded = value
    .replaceAll('-', '+')
    .replaceAll('_', '/')
    .padEnd(Math.ceil(value.length / 4) * 4, '=');
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    throw new Error('Invalid base64url value');
  }
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

/** Encode bytes as unpadded base64url without relying on Node-only Buffer. */
export function encodeBase64Url(value: Uint8Array): string {
  let binary = '';
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function asArrayBuffer(value: Uint8Array): ArrayBuffer {
  return value.slice().buffer;
}

function concatBytes(...values: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(values.reduce((total, value) => total + value.length, 0));
  let offset = 0;
  for (const value of values) {
    result.set(value, offset);
    offset += value.length;
  }
  return result;
}

function validatePublicKey(value: string, label: string): Uint8Array {
  const decoded = decodeBase64Url(value);
  if (decoded.length !== P256_PUBLIC_KEY_BYTES || decoded[0] !== 0x04) {
    throw new Error(`${label} must be a 65-byte uncompressed P-256 public key`);
  }
  return decoded;
}

function validatePrivateKey(value: string, label: string): Uint8Array {
  const decoded = decodeBase64Url(value);
  if (decoded.length !== P256_PRIVATE_KEY_BYTES) {
    throw new Error(`${label} must be a 32-byte P-256 private key`);
  }
  return decoded;
}

function publicKeyJwk(publicKey: Uint8Array): JsonWebKey {
  return {
    kty: 'EC',
    crv: 'P-256',
    x: encodeBase64Url(publicKey.slice(1, 33)),
    y: encodeBase64Url(publicKey.slice(33, 65)),
    ext: true,
  };
}

async function hkdfExtract(salt: Uint8Array, inputKeyMaterial: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    asArrayBuffer(salt),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, asArrayBuffer(inputKeyMaterial)));
}

async function hkdfExpand(
  pseudoRandomKey: Uint8Array,
  info: Uint8Array,
  length: number
): Promise<Uint8Array> {
  if (length > 32) throw new Error('Web Push HKDF expansion exceeds one SHA-256 block');
  const key = await crypto.subtle.importKey(
    'raw',
    asArrayBuffer(pseudoRandomKey),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const block = await crypto.subtle.sign(
    'HMAC',
    key,
    asArrayBuffer(concatBytes(info, Uint8Array.of(1)))
  );
  return new Uint8Array(block).slice(0, length);
}

async function resolveSenderKeyPair(options: WebPushEncryptionOptions): Promise<{
  privateKey: CryptoKey;
  publicKey: Uint8Array;
}> {
  const hasPrivate = options.senderPrivateKey !== undefined;
  const hasPublic = options.senderPublicKey !== undefined;
  if (hasPrivate !== hasPublic) {
    throw new Error('senderPrivateKey and senderPublicKey must be provided together');
  }

  if (options.senderPrivateKey && options.senderPublicKey) {
    const publicKey = validatePublicKey(options.senderPublicKey, 'senderPublicKey');
    const privateKey = validatePrivateKey(options.senderPrivateKey, 'senderPrivateKey');
    return {
      privateKey: await crypto.subtle.importKey(
        'jwk',
        { ...publicKeyJwk(publicKey), d: encodeBase64Url(privateKey) },
        { name: 'ECDH', namedCurve: 'P-256' },
        false,
        ['deriveBits']
      ),
      publicKey,
    };
  }

  const generated = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveBits',
  ])) as CryptoKeyPair;
  const exportedPublicKey = await crypto.subtle.exportKey('raw', generated.publicKey);
  return {
    privateKey: generated.privateKey,
    publicKey: new Uint8Array(exportedPublicKey as ArrayBuffer),
  };
}

/**
 * Encrypt one final aes128gcm record using the RFC 8291 Web Push construction.
 * Optional deterministic sender/salt inputs exist solely for published-vector tests.
 */
export async function encryptWebPushPayload(
  subscription: WebPushSubscription,
  payload: string | Uint8Array,
  options: WebPushEncryptionOptions = {}
): Promise<Uint8Array> {
  const receiverPublicKey = validatePublicKey(subscription.p256dh, 'p256dh');
  const authSecret = decodeBase64Url(subscription.auth);
  if (authSecret.length !== AUTH_SECRET_BYTES) {
    throw new Error(`auth must be a ${AUTH_SECRET_BYTES}-byte secret`);
  }

  const salt = options.salt
    ? decodeBase64Url(options.salt)
    : crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  if (salt.length !== SALT_BYTES) throw new Error(`salt must be ${SALT_BYTES} bytes`);

  const sender = await resolveSenderKeyPair(options);
  const receiverKey = await crypto.subtle.importKey(
    'raw',
    asArrayBuffer(receiverPublicKey),
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    []
  );
  const sharedSecret = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'ECDH', public: receiverKey } as unknown as SubtleCryptoDeriveKeyAlgorithm,
      sender.privateKey,
      256
    )
  );

  const keyInfo = concatBytes(
    encoder.encode('WebPush: info'),
    Uint8Array.of(0),
    receiverPublicKey,
    sender.publicKey
  );
  const authPseudoRandomKey = await hkdfExtract(authSecret, sharedSecret);
  const inputKeyMaterial = await hkdfExpand(authPseudoRandomKey, keyInfo, 32);
  const pseudoRandomKey = await hkdfExtract(salt, inputKeyMaterial);
  const contentEncryptionKey = await hkdfExpand(
    pseudoRandomKey,
    concatBytes(encoder.encode('Content-Encoding: aes128gcm'), Uint8Array.of(0)),
    AES_128_GCM_KEY_BYTES
  );
  const nonce = await hkdfExpand(
    pseudoRandomKey,
    concatBytes(encoder.encode('Content-Encoding: nonce'), Uint8Array.of(0)),
    NONCE_BYTES
  );

  const plaintext = typeof payload === 'string' ? encoder.encode(payload) : payload;
  const record = concatBytes(plaintext, Uint8Array.of(0x02));
  const aesKey = await crypto.subtle.importKey(
    'raw',
    asArrayBuffer(contentEncryptionKey),
    'AES-GCM',
    false,
    ['encrypt']
  );
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: asArrayBuffer(nonce), tagLength: 128 },
      aesKey,
      asArrayBuffer(record)
    )
  );

  const header = new Uint8Array(SALT_BYTES + 4 + 1 + sender.publicKey.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(SALT_BYTES, RECORD_SIZE, false);
  header[SALT_BYTES + 4] = sender.publicKey.length;
  header.set(sender.publicKey, SALT_BYTES + 5);
  return concatBytes(header, ciphertext);
}

function validateEndpoint(endpoint: string): URL {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error('Web Push endpoint must be a valid HTTPS URL');
  }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('Web Push endpoint must be a valid HTTPS URL without credentials');
  }
  return url;
}

/** Validate persisted browser subscription fields at the API/DO boundary. */
export function validateWebPushSubscription(subscription: WebPushSubscription): void {
  validateEndpoint(subscription.endpoint);
  validatePublicKey(subscription.p256dh, 'p256dh');
  const authSecret = decodeBase64Url(subscription.auth);
  if (authSecret.length !== AUTH_SECRET_BYTES) {
    throw new Error(`auth must be a ${AUTH_SECRET_BYTES}-byte secret`);
  }
}

function validateVapidSubject(subject: string): void {
  if (subject.startsWith('mailto:')) {
    if (!/^mailto:[^@\s]+@[^@\s]+$/.test(subject)) {
      throw new Error('VAPID subject must be a valid mailto or HTTPS URI');
    }
    return;
  }
  try {
    if (new URL(subject).protocol !== 'https:') throw new Error('invalid protocol');
  } catch {
    throw new Error('VAPID subject must be a valid mailto or HTTPS URI');
  }
}

/** Create the RFC 8292 `Authorization: vapid ...` header value. */
export async function createVapidAuthorization(
  endpoint: string,
  vapid: VapidKeyMaterial,
  options: VapidAuthorizationOptions = {}
): Promise<string> {
  const endpointUrl = validateEndpoint(endpoint);
  validateVapidSubject(vapid.subject);
  const ttlSeconds = options.ttlSeconds ?? 12 * 60 * 60;
  if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0 || ttlSeconds > MAX_VAPID_TTL_SECONDS) {
    throw new Error('VAPID expiration must be a positive integer no more than 24 hours');
  }

  const publicKey = validatePublicKey(vapid.publicKey, 'VAPID public key');
  const privateKey = validatePrivateKey(vapid.privateKey, 'VAPID private key');
  const signingKey = await crypto.subtle.importKey(
    'jwk',
    { ...publicKeyJwk(publicKey), d: encodeBase64Url(privateKey) },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign']
  );
  const issuedAt = Math.floor((options.now ?? new Date()).getTime() / 1000);
  const header = encodeBase64Url(encoder.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = encodeBase64Url(
    encoder.encode(
      JSON.stringify({
        aud: endpointUrl.origin,
        exp: issuedAt + ttlSeconds,
        sub: vapid.subject,
      })
    )
  );
  const unsignedToken = `${header}.${claims}`;
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      signingKey,
      asArrayBuffer(encoder.encode(unsignedToken))
    )
  );
  return `vapid t=${unsignedToken}.${encodeBase64Url(signature)}, k=${vapid.publicKey}`;
}
