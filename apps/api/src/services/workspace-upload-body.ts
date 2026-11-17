import { withDeadline } from './fetch-timeout';

interface MultipartBody {
  body: ReadableStream<Uint8Array>;
  contentType: string;
  finished: Promise<void>;
  stop: (error: unknown) => void;
  failure: () => unknown;
}

/** Standard multipart encoding, without a file-sized Blob/FormData backing copy. */
function multipartBody(data: ArrayBuffer, filename: string, destination: string): MultipartBody {
  const boundary = `sam-${crypto.randomUUID()}`;
  const encoder = new TextEncoder();
  // WHATWG multipart escaping prevents a filename from creating another header or part.
  const escapedFilename = filename.replace(/[\r\n"]/g, (char) => {
    if (char === '\r') return '%0D';
    if (char === '\n') return '%0A';
    return '%22';
  });
  const normalizedDestination = destination.replace(/\r\n|\r|\n/g, '\r\n');
  const segments = [
    encoder.encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="destination"\r\n\r\n${normalizedDestination}\r\n` +
        `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${escapedFilename}"\r\n` +
        'Content-Type: application/octet-stream\r\n\r\n'
    ),
    new Uint8Array(data),
    encoder.encode(`\r\n--${boundary}--\r\n`),
  ];
  let offset = 0;
  let terminated = false;
  let failure: unknown;
  let controller: ReadableByteStreamController;
  let complete!: () => void;
  const finished = new Promise<void>((resolve) => {
    complete = resolve;
  });
  const terminate = (error?: unknown) => {
    if (terminated) return;
    terminated = true;
    failure = error;
    // No source closure keeps the whole plaintext after completion/error/cancellation.
    segments.length = 0;
    complete();
  };
  const body = new ReadableStream(
    {
      type: 'bytes',
      start(active) {
        controller = active;
      },
      pull(active) {
        while (segments[0]?.byteLength === offset) {
          segments.shift();
          offset = 0;
        }
        const segment = segments[0];
        if (!segment) {
          // Close on the EOF read, after the consumer has requested the last chunk.
          active.close();
          active.byobRequest?.respond(0);
          terminate();
          return;
        }
        const end = Math.min(offset + 64 * 1024, segment.byteLength);
        // The byte stream transfers this bounded COPY to its consumer. Never detach or
        // reuse consumer-owned chunks; opaque container RPCs may retain them after timeout.
        active.enqueue(segment.slice(offset, end));
        offset = end;
      },
      cancel(reason) {
        terminate(reason ?? new Error('Workspace upload body cancelled'));
      },
    },
    { highWaterMark: 0 }
  );
  return {
    body,
    contentType: `multipart/form-data; boundary=${boundary}`,
    finished,
    failure: () => failure,
    stop(error) {
      if (terminated) return;
      controller.error(error);
      terminate(error);
    },
  };
}

/**
 * Hold caller ownership until request-body termination AND exposed fetch settlement.
 * The existing transfer budget also stops an early-response or stalled request body.
 */
export async function sendWorkspaceMultipart(
  data: ArrayBuffer,
  filename: string,
  destination: string,
  timeoutMs: number,
  send: (
    body: ReadableStream<Uint8Array>,
    contentType: string,
    signal: AbortSignal
  ) => Promise<Response>
): Promise<void> {
  const upload = multipartBody(data, filename, destination);
  let request: Promise<Response> | undefined;
  let response: Response | undefined;
  try {
    await withDeadline(async (signal) => {
      const onAbort = () => upload.stop(signal.reason);
      signal.addEventListener('abort', onAbort, { once: true });
      try {
        request = Promise.resolve().then(() => send(upload.body, upload.contentType, signal));
        response = await request;
        if (!response.ok) {
          upload.stop(new Error('VM agent rejected workspace upload'));
          const text = await response.text().catch(() => 'unknown');
          throw new Error(`VM agent upload failed: ${response.status} ${text}`);
        }
        await upload.finished;
        const failure = upload.failure();
        if (failure !== undefined) throw failure;
        // A successful upload has no response payload contract. Cancel it to release
        // the existing fetchWithTimeout/deadlineResponse timer and upstream resources.
        await response.body?.cancel();
      } catch (error) {
        upload.stop(error);
        throw error;
      } finally {
        signal.removeEventListener('abort', onAbort);
      }
    }, timeoutMs);
  } catch (error) {
    upload.stop(error);
    // fetchNodeAgent has its own same-budget deadline, including the container RPC
    // adapter. Its hidden loser can retain bounded chunks, never our whole-file view.
    if (request) response = await request.catch(() => undefined);
    await upload.finished;
    void response?.body?.cancel().catch(() => {});
    throw error;
  }
}
