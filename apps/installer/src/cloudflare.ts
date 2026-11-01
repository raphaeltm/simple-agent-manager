const API = 'https://api.cloudflare.com/client/v4';
export class CloudflareError extends Error {
  constructor(public status: number) {
    super(`Cloudflare request failed (${status}). Check the granted permissions and retry.`);
  }
}
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
  const data = (await response.json()) as { success: boolean; result: T };
  if (!response.ok || !data.success) throw new CloudflareError(response.status);
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
