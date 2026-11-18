import { describe, expect, it, vi } from 'vitest';

import { IoTimeoutError } from '../../src/services/fetch-timeout';
import { deadlineResponse } from '../../src/services/fetch-timeout-body';

describe('response deadlines in workerd', () => {
  it('does not start reading an abandoned response and cleans up explicit cancellation', async () => {
    const pull = vi.fn();
    const cancel = vi.fn();
    const cleanup = vi.fn();
    const source = new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 });
    const response = deadlineResponse(new Response(source), new AbortController().signal, cleanup);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(pull).not.toHaveBeenCalled();
    await response.body!.cancel('navigation');
    expect(cancel).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('still rejects consumed bodies on an upstream error', async () => {
    const cleanup = vi.fn();
    let upstream!: ReadableStreamDefaultController<Uint8Array>;
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        upstream = controller;
      },
    });
    const response = deadlineResponse(new Response(source), new AbortController().signal, cleanup);
    const outcome = response.text().then(
      () => undefined,
      (error: unknown) => error
    );
    upstream.error(new Error('upstream body failed'));
    expect(await outcome).toMatchObject({ message: 'upstream body failed' });
    expect(cleanup).toHaveBeenCalledOnce();
  });

  // Control: native bodies reproduce the legacy rejection tracker independently
  // of deadlineResponse. The compatibility flag must preserve the caught error.
  it('propagates an upstream error through a native Response without a false unhandled report', async () => {
    let upstream!: ReadableStreamDefaultController<Uint8Array>;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          upstream = controller;
        },
      })
    );
    const outcome = response.text().then(
      () => undefined,
      (error: unknown) => error
    );
    upstream.error(new Error('native upstream body failed'));
    expect(await outcome).toMatchObject({ message: 'native upstream body failed' });
  });

  it('aborts a stalled consumed body at the deadline', async () => {
    const abort = new AbortController();
    const cleanup = vi.fn();
    const source = new ReadableStream<Uint8Array>({
      pull() {
        return new Promise(() => {});
      },
    });
    const response = deadlineResponse(new Response(source), abort.signal, cleanup);
    const outcome = response.text().then(
      () => undefined,
      (error: unknown) => error
    );
    abort.abort(new IoTimeoutError('body deadline'));
    expect(await outcome).toMatchObject({ name: 'TimeoutError', message: 'body deadline' });
    expect(cleanup).toHaveBeenCalledOnce();
  });
});
