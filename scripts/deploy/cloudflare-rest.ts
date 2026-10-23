/**
 * Minimal Cloudflare v4 REST client for deploy scripts: one request seam that tests can
 * replace, an error that keeps the HTTP status and Cloudflare error codes, auth-failure
 * detection for permission probes, and a write counter so idempotent re-runs can be asserted.
 */

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH';

export interface CloudflareEnvelope {
  success?: boolean;
  errors?: Array<{ code?: number; message?: string }>;
  result?: unknown;
  result_info?: { count?: number; total_count?: number };
}

export interface CloudflareResponse {
  status: number;
  body: CloudflareEnvelope;
}

export type CloudflareRequest = (
  method: HttpMethod,
  path: string,
  body?: unknown
) => Promise<CloudflareResponse>;

export class CloudflareApiError extends Error {
  constructor(
    readonly method: HttpMethod,
    readonly path: string,
    readonly response: CloudflareResponse
  ) {
    const detail = (response.body.errors ?? [])
      .map((error) => `${error.code ?? '?'} ${error.message ?? ''}`.trim())
      .join('; ');
    super(
      `Cloudflare ${method} ${path} failed with HTTP ${response.status}: ${detail || 'no detail'}`
    );
  }
}

export function isAuthFailure(response: CloudflareResponse): boolean {
  if (response.status === 401 || response.status === 403) return true;
  return (response.body.errors ?? []).some(
    (error) => error.code === 10000 || /authentication|unauthori[sz]ed/i.test(error.message ?? '')
  );
}

/** Counts write calls so idempotent re-runs can be asserted and reported. */
export class Api {
  writes = 0;
  constructor(private readonly request: CloudflareRequest) {}

  async raw(method: HttpMethod, path: string, body?: unknown): Promise<CloudflareResponse> {
    if (method !== 'GET') this.writes += 1;
    return this.request(method, path, body);
  }

  async call<T>(method: HttpMethod, path: string, body?: unknown): Promise<T> {
    const response = await this.raw(method, path, body);
    if (response.status < 200 || response.status >= 300 || response.body.success === false) {
      throw new CloudflareApiError(method, path, response);
    }
    return response.body.result as T;
  }
}

export function fetchRequest(apiToken: string): CloudflareRequest {
  return async (method, path, body) => {
    const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${apiToken}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let parsed: unknown = {};
    try {
      parsed = text ? (JSON.parse(text) as unknown) : {};
    } catch {
      parsed = { success: false, errors: [{ message: text.slice(0, 200) }] };
    }
    return { status: response.status, body: toEnvelope(parsed) };
  };
}

/** Narrow a Cloudflare v4 response body; anything unexpected becomes an unsuccessful envelope. */
export function toEnvelope(value: unknown): CloudflareEnvelope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { success: false, errors: [{ message: 'Cloudflare returned a non-object body' }] };
  }
  const record = value as Record<string, unknown>;
  const errors = Array.isArray(record.errors)
    ? record.errors.map((entry) => {
        const error = entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : {};
        return {
          code: typeof error.code === 'number' ? error.code : undefined,
          message: typeof error.message === 'string' ? error.message : undefined,
        };
      })
    : undefined;
  const info =
    record.result_info && typeof record.result_info === 'object'
      ? (record.result_info as Record<string, unknown>)
      : null;
  return {
    success: typeof record.success === 'boolean' ? record.success : undefined,
    errors,
    result: record.result,
    // List endpoints report their counts here; callers that compare lists need them.
    ...(info
      ? {
          result_info: {
            count: typeof info.count === 'number' ? info.count : undefined,
            total_count: typeof info.total_count === 'number' ? info.total_count : undefined,
          },
        }
      : {}),
  };
}
