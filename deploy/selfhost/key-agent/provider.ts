/**
 * The one operation SAM asks of a key service: wrap and unwrap a 32-byte data key with a
 * key-encryption key (KEK) that never leaves the service. Every implementation passes the same
 * conformance suite (scripts/selfhost/key-provider-conformance.ts), so the interface cannot take
 * the shape of one cloud.
 *
 * Runs under Node's type stripping (no enums, no parameter properties, `.ts` specifiers).
 */

/** What the caller should do about a failure; categories name the recovery, not the service. */
export type KeyProviderErrorKind =
  /** The service could not be reached or answered 5xx/429: retry later, a cached copy may serve. */
  | 'unavailable'
  /** The service refused this identity or key (401/403, disabled key): do NOT serve a cached copy. */
  | 'denied'
  /** The blob or context does not verify under this key: the bundle is wrong or tampered with. */
  | 'invalid'
  /** The provider is misconfigured on this box (missing setting, unreadable credential file). */
  | 'config';

export class KeyProviderError extends Error {
  readonly kind: KeyProviderErrorKind;
  /**
   * True only when the key service itself said the KEY does not exist (Cloud KMS or Key Vault 404
   * on the key, AWS NotFoundException). Never set for a missing VM identity, a 404 from a token
   * endpoint or a wrong key usage, which share kind `config`. The automatic key choice
   * (scripts/selfhost/key-choice.ts, candidateFloor) reads this as "no key was set up".
   */
  readonly keyMissing: boolean;
  constructor(kind: KeyProviderErrorKind, message: string, options: { keyMissing?: boolean } = {}) {
    super(message);
    this.name = 'KeyProviderError';
    this.kind = kind;
    this.keyMissing = options.keyMissing === true;
  }
}

export interface KeyProvider {
  /** Provider id recorded in the bundle header: `file`, `transit`, `gcp-kms`, `azure-kv`, … */
  readonly name: string;
  /**
   * Non-secret identifier of the KEK (a resource name or a key fingerprint), recorded in the
   * bundle header so a bundle is never handed to the wrong key.
   */
  readonly keyRef: string;
  /**
   * Whether the service itself authenticates `context` (AAD / encryption context). Azure Key
   * Vault's RSA wrapKey does not; the bundle's own AEAD binds the header either way.
   */
  readonly bindsContext: boolean;
  wrap(dataKey: Uint8Array, context: Uint8Array): Promise<Uint8Array>;
  unwrap(wrapped: Uint8Array, context: Uint8Array): Promise<Uint8Array>;
}

/** Upper bound on any single key-service HTTP call. */
export const DEFAULT_KEY_SERVICE_TIMEOUT_MS = 5000;

export function b64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

export function unb64(text: unknown, what: string): Uint8Array {
  if (typeof text !== 'string' || !/^[A-Za-z0-9+/_-]*={0,2}$/.test(text)) {
    throw new KeyProviderError('invalid', `${what} is not base64`);
  }
  return new Uint8Array(Buffer.from(text, 'base64'));
}

/** Maps an HTTP status from a key service to the recovery the caller should take. */
export function kindForStatus(status: number): KeyProviderErrorKind {
  if (status === 401 || status === 403) return 'denied';
  if (status === 429 || status >= 500) return 'unavailable';
  // 400/404/409: the request, the key name or the blob is wrong. Not retryable.
  return status === 404 ? 'config' : 'invalid';
}

export interface JsonCallOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
  /** Text naming the service in errors (never a credential). */
  service: string;
  /** The URL names the key itself, so a 404 means the key does not exist (keyMissing). */
  keyResource?: boolean;
}

/** An error body larger than this is not read: the status token sits at its start. */
const MAX_ERROR_BODY_BYTES = 16 * 1024;
/** Only an enum-like token (`FAILED_PRECONDITION`, `KeyNotFound`) is kept, never free text. */
const ERROR_STATUS = /^[A-Za-z][A-Za-z_]{0,63}$/;

/**
 * The machine-readable status of a key service's error answer (`error.status` on Cloud KMS,
 * `error.code` on Key Vault), so "HTTP 400" can say FAILED_PRECONDITION (a key with no enabled
 * version) instead of leaving the operator to guess. Only a token matching ERROR_STATUS is
 * returned: the message and the rest of the body are discarded, since some services echo the
 * request, which here carries key material.
 */
async function errorStatus(response: Response): Promise<string | null> {
  try {
    const reader = response.body?.getReader();
    if (!reader) return null;
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_ERROR_BODY_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    const status = field(parsed, 'error', 'status') ?? field(parsed, 'error', 'code');
    return typeof status === 'string' && ERROR_STATUS.test(status) ? status : null;
  } catch {
    return null;
  }
}

/**
 * One JSON request to a key service. Errors never include the response body (some services echo
 * the request, which here carries key material), only its status token (errorStatus).
 */
export async function jsonCall(url: string, options: JsonCallOptions): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: options.method ?? 'POST',
      headers: {
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...options.headers,
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      redirect: 'error',
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_KEY_SERVICE_TIMEOUT_MS),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.name : 'error';
    throw new KeyProviderError('unavailable', `${options.service}: request failed (${reason})`);
  }
  if (!response.ok) {
    const status = await errorStatus(response);
    throw new KeyProviderError(
      kindForStatus(response.status),
      `${options.service}: HTTP ${response.status}${status ? ` ${status}` : ''}`,
      { keyMissing: options.keyResource === true && response.status === 404 }
    );
  }
  try {
    return (await response.json()) as unknown;
  } catch {
    throw new KeyProviderError('unavailable', `${options.service}: response is not JSON`);
  }
}

export function field(value: unknown, ...path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

export function requireSetting(
  env: Readonly<Record<string, string | undefined>>,
  name: string
): string {
  const value = env[name]?.trim();
  if (!value) throw new KeyProviderError('config', `${name} is required for this key provider`);
  return value;
}
