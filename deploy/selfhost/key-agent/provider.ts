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
  constructor(kind: KeyProviderErrorKind, message: string) {
    super(message);
    this.name = 'KeyProviderError';
    this.kind = kind;
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
}

/**
 * One JSON request to a key service. Errors never include the response body: some services echo
 * the request, which here carries key material.
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
    await response.body?.cancel();
    throw new KeyProviderError(
      kindForStatus(response.status),
      `${options.service}: HTTP ${response.status}`
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
