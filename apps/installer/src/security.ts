export function randomSecret(): string {
  return [...crypto.getRandomValues(new Uint8Array(32))]
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('');
}
export async function digest(value: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))]
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('');
}
export async function challenge(value: string): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  );
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}
export function cookieName(origin: string): string {
  return origin.startsWith('https:') ? '__Host-sam-installer' : 'sam-installer-local';
}
export function sessionCookie(origin: string, id: string, ttl: number): string {
  return `${cookieName(origin)}=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${ttl}${origin.startsWith('https:') ? '; Secure' : ''}`;
}
export function sessionId(request: Request, origin: string): string | undefined {
  const value = request.headers
    .get('cookie')
    ?.split(';')
    .map((x) => x.trim())
    .find((x) => x.startsWith(`${cookieName(origin)}=`))
    ?.split('=')[1];
  return value && /^[a-f0-9]{64}$/.test(value) ? value : undefined;
}
export function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}
export function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c
  );
}

/** Enforce actual bytes, including requests without a Content-Length header. */
export async function boundedBody(request: Request, limit = 4096): Promise<string | null> {
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}
