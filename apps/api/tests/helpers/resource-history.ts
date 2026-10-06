export function base64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function gzipText(value: string): Promise<Uint8Array> {
  return gzipBytes(new TextEncoder().encode(value));
}

export async function gzipBytes(value: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([value]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export function gzipJson(value: unknown): Promise<Uint8Array> {
  return gzipText(JSON.stringify(value));
}

export async function gunzipJson(bytes: Uint8Array): Promise<unknown> {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return JSON.parse(await new Response(stream).text()) as unknown;
}
