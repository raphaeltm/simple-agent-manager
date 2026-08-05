export class RequestBodyTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`Request body exceeds ${maxBytes} bytes`);
    this.name = 'RequestBodyTooLargeError';
  }
}

/** Read a request body without trusting Content-Length. */
export async function readBoundedRequestBody(
  request: Request,
  maxBytes: number
): Promise<Uint8Array> {
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let chunk = await reader.read();
  while (!chunk.done) {
    size += chunk.value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new RequestBodyTooLargeError(maxBytes);
    }
    chunks.push(chunk.value);
    chunk = await reader.read();
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const value of chunks) {
    body.set(value, offset);
    offset += value.byteLength;
  }
  return body;
}
