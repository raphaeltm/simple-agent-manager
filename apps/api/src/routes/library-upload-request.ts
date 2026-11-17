import type { MiddlewareHandler } from 'hono';

import type { Env } from '../env';
import { errors } from '../middleware/error';

let uploadInProgress = false;

/** Keep whole-file multipart materialization to one request per Worker isolate. */
export const limitLibraryUploadConcurrency: MiddlewareHandler<{ Bindings: Env }> = async (
  _c,
  next
) => {
  if (uploadInProgress) {
    throw errors.tooManyRequests('Another library upload is in progress. Please retry shortly.');
  }
  uploadInProgress = true;
  try {
    await next();
  } finally {
    uploadInProgress = false;
  }
};

function boundedBodyStream(
  source: ReadableStream<Uint8Array>,
  maxBodyBytes: number,
  onExceeded: () => void
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let receivedBytes = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          controller.close();
          return;
        }
        receivedBytes += chunk.value.byteLength;
        if (receivedBytes > maxBodyBytes) {
          onExceeded();
          await reader.cancel('library multipart body limit exceeded');
          controller.error(new Error('Library multipart body limit exceeded'));
          return;
        }
        controller.enqueue(chunk.value);
      } catch (error) {
        controller.error(error);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

/** Parse multipart fields while aborting the source stream at the configured request bound. */
export async function parseLibraryMultipartBody(
  request: Request,
  maxBodyBytes: number
): Promise<FormData> {
  const declaredLength = Number.parseInt(request.headers.get('content-length') ?? '', 10);
  if (Number.isFinite(declaredLength) && declaredLength > maxBodyBytes) {
    throw errors.badRequest(`Multipart request exceeds maximum size of ${maxBodyBytes} bytes`);
  }

  let bodyLimitExceeded = false;
  const source = request.body;
  const boundedBody = source
    ? boundedBodyStream(source, maxBodyBytes, () => {
        bodyLimitExceeded = true;
      })
    : null;
  const contentType = request.headers.get('content-type');

  try {
    return await new Response(boundedBody, {
      headers: contentType ? { 'Content-Type': contentType } : undefined,
    }).formData();
  } catch {
    if (bodyLimitExceeded) {
      throw errors.badRequest(`Multipart request exceeds maximum size of ${maxBodyBytes} bytes`);
    }
    throw errors.badRequest('Failed to parse multipart form data');
  }
}

export function getMultipartText(formData: FormData, field: string): string | undefined {
  const value = formData.get(field);
  return typeof value === 'string' ? value : undefined;
}
