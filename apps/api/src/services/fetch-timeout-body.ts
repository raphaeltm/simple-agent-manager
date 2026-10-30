/** Preserve streaming while keeping the fetch deadline alive until EOF or cancellation. */
export function deadlineResponse(
  response: Response,
  signal: AbortSignal,
  cleanup: () => void
): Response {
  if (!response.body) {
    cleanup();
    return response;
  }
  const reader = response.body.getReader();
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    signal.removeEventListener('abort', onAbort);
    cleanup();
  };
  let bodyController: ReadableStreamDefaultController<Uint8Array>;
  const onAbort = () => {
    if (finished) return;
    bodyController.error(signal.reason);
    finish();
    void reader.cancel(signal.reason).catch(() => {});
  };
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      bodyController = controller;
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
    },
    async pull(controller) {
      try {
        const result = await reader.read();
        if (finished) return;
        if (result.done) {
          finish();
          controller.close();
        } else controller.enqueue(result.value);
      } catch (error) {
        if (finished) return;
        finish();
        controller.error(error);
      }
    },
    cancel(reason) {
      finish();
      return reader.cancel(reason);
    },
  });
  const bounded = new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
  // These fetch metadata fields are otherwise lost when reconstructing a response.
  for (const key of ['url', 'redirected', 'type'] as const)
    Object.defineProperty(bounded, key, { value: response[key] });
  return bounded;
}
