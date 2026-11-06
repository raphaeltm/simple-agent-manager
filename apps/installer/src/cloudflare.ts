const API = 'https://api.cloudflare.com/client/v4';
export class CloudflareError extends Error {
  constructor(
    public status: number,
    // Diagnostic context only: method, account-masked API path, Cloudflare's
    // numeric error codes and the response content type. Never tokens, bodies
    // or provider error text, which can echo request values.
    public detail: {
      method?: string;
      path?: string;
      codes?: number[];
      contentType?: string;
    } = {}
  ) {
    super(`Cloudflare request failed (${status}). Check the granted permissions and retry.`);
  }
}
const maskPath = (path: string) => path.replace(/\/accounts\/[^/]+/, '/accounts/:account');
export async function cloudflare<T>(
  token: string,
  path: string,
  init: RequestInit = {}
): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: { ...Object.fromEntries(new Headers(init.headers)), Authorization: `Bearer ${token}` },
    signal: init.signal
      ? AbortSignal.any([init.signal, AbortSignal.timeout(30_000)])
      : AbortSignal.timeout(30_000),
  });
  const data = (await response.json().catch(() => ({ success: false }))) as {
    success: boolean;
    result: T;
    errors?: { code?: unknown }[];
  };
  if (!response.ok || !data.success)
    throw new CloudflareError(response.status, {
      method: init.method ?? 'GET',
      path: maskPath(path),
      codes: (data.errors ?? [])
        .map((error) => error.code)
        .filter((code): code is number => typeof code === 'number'),
      contentType: response.headers.get('content-type') ?? '',
    });
  return data.result;
}
export async function revoke(token: string): Promise<boolean> {
  try {
    const response = await fetch('https://dash.cloudflare.com/oauth2/revoke', {
      method: 'POST',
      body: new URLSearchParams({ token }),
      signal: AbortSignal.timeout(10_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}
