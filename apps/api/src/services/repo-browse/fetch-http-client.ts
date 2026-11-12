/**
 * An isomorphic-git HTTP client over an injected fetch. `isomorphic-git/http/web` always uses the
 * global fetch; SAM-hosted repositories are browsed in-process (`artifactsRemoteFetch`), so the
 * browser needs a client that takes the fetch as a parameter. Same request/response contract as
 * `isomorphic-git/http/web`.
 */
import type { HttpClient } from 'isomorphic-git';

async function collect(body: AsyncIterableIterator<Uint8Array> | undefined): Promise<Uint8Array> {
  if (!body) return new Uint8Array(0);
  const parts: Uint8Array[] = [];
  let size = 0;
  for await (const part of body) {
    parts.push(part);
    size += part.byteLength;
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

async function* streamChunks(stream: ReadableStream<Uint8Array> | null): AsyncGenerator<Uint8Array> {
  if (!stream) return;
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

export function createFetchHttpClient(fetchImpl: typeof fetch): HttpClient {
  return {
    async request({ url, method = 'GET', headers = {}, body }) {
      const payload = body ? await collect(body) : undefined;
      const res = await fetchImpl(url, { method, headers, body: payload });
      const responseHeaders: Record<string, string> = {};
      res.headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });
      return {
        url: res.url || url,
        method,
        statusCode: res.status,
        statusMessage: res.statusText,
        body: streamChunks(res.body),
        headers: responseHeaders,
      };
    },
  };
}
