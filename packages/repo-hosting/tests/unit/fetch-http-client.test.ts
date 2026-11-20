import { describe, expect, it, vi } from 'vitest';

import { createFetchHttpClient } from '../../src/repo-browse/fetch-http-client';

/** A response whose stream records whether it was cancelled (Codex r4636466068). */
function trackedResponse(chunks: number) {
  const cancel = vi.fn();
  let sent = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent++ < chunks) controller.enqueue(new Uint8Array([sent]));
      else controller.close();
    },
    cancel,
  });
  return { response: new Response(body), cancel };
}

describe('createFetchHttpClient response body', () => {
  it('cancels the upstream response when the consumer abandons the iterator early', async () => {
    const { response, cancel } = trackedResponse(10);
    const client = createFetchHttpClient(async () => response);
    const res = await client.request({ url: 'https://repo.example/info/refs', method: 'GET' });
    const body = res.body as AsyncIterableIterator<Uint8Array>;
    expect((await body.next()).done).toBe(false);
    await body.return?.(undefined); // what a for-await `break` or a thrown parse error does
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('does not cancel a response read to the end', async () => {
    const { response, cancel } = trackedResponse(3);
    const client = createFetchHttpClient(async () => response);
    const res = await client.request({ url: 'https://repo.example/info/refs', method: 'GET' });
    let seen = 0;
    for await (const chunk of res.body as AsyncIterableIterator<Uint8Array>) seen += chunk.length;
    expect(seen).toBe(3);
    expect(cancel).not.toHaveBeenCalled();
  });
});
