import { releaseArrayBuffer } from '../lib/release-array-buffer';
import { errors } from '../middleware/error';
import { LIBRARY_MULTIPART_DEFAULTS } from './admin-settings-library-definitions';

/**
 * Per-isolate budget for file-sized Library buffers, in file bytes. One maximum-size
 * file uses all of it, which is the peak the memory invariant was measured at
 * (plaintext + ciphertext for a 50 MiB file). Smaller transfers share it, so the
 * several small uploads or previews a page issues together do not refuse each other.
 */
export const LIBRARY_MEMORY_BUDGET_BYTES = LIBRARY_MULTIPART_DEFAULTS.fileMaxBytes;
/** Smallest reservation: one 64 KiB parser/egress chunk, so tiny files are never free. */
export const LIBRARY_MEMORY_MIN_RESERVATION_BYTES = 64 * 1024;

let reservedBytes = 0;

/** Bytes to reserve for a transfer of `size` bytes; unknown or invalid sizes take the whole budget. */
export function libraryMemoryReservation(size?: number): number {
  if (size === undefined || !Number.isSafeInteger(size) || size < 0) {
    return LIBRARY_MEMORY_BUDGET_BYTES;
  }
  return Math.min(
    LIBRARY_MEMORY_BUDGET_BYTES,
    Math.max(LIBRARY_MEMORY_MIN_RESERVATION_BYTES, size)
  );
}

/**
 * Reserve Library memory for one materializing operation; rejected callers never queue
 * buffers. `size` must bound the bytes the caller will hold (a declared request length
 * enforced while streaming, or stored file metadata); omit it when the size is unknown.
 */
export function acquireLibraryMemory(size?: number): () => void {
  const amount = libraryMemoryReservation(size);
  if (reservedBytes + amount > LIBRARY_MEMORY_BUDGET_BYTES) {
    throw errors.tooManyRequests('Another Library transfer is in progress. Please retry shortly.');
  }
  reservedBytes += amount;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    reservedBytes -= amount;
  };
}

/** The callback must await every consumer of its owned file buffers before returning. */
export async function withLibraryMemory<T>(operation: () => Promise<T>, size?: number): Promise<T> {
  const release = acquireLibraryMemory(size);
  try {
    return await operation();
  } finally {
    release();
  }
}

interface DownloadOwner<T> {
  value: T;
  dispose: () => void;
  stream: (start?: number, endExclusive?: number) => ReadableStream<Uint8Array>;
  consume: <R>(operation: (value: T) => Promise<R>) => Promise<R>;
}

/**
 * Load owns the permit even after its caller times out: crypto/R2 may still be live.
 * After success, ownership follows plaintext through response consumption or disposal.
 * The existing download timeout bounds each phase; at 50 MiB / 60s, egress needs 854 KiB/s.
 */
export async function loadLibraryDownload<T extends { data: ArrayBuffer }>(
  load: () => Promise<T>,
  timeoutMs: number,
  size?: number
): Promise<DownloadOwner<T>> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw errors.internal('Library download timeout is unavailable');
  }
  const release = acquireLibraryMemory(size);
  const value = await new Promise<T>((resolve, reject) => {
    let expired = false;
    const timeout = setTimeout(() => {
      expired = true;
      reject(errors.internal('Library download timed out'));
    }, timeoutMs);
    void Promise.resolve()
      .then(load)
      .then(
        (result) => {
          clearTimeout(timeout);
          if (expired) {
            try {
              releaseArrayBuffer(result.data);
            } finally {
              release();
            }
          } else {
            resolve(result);
          }
        },
        (error: unknown) => {
          clearTimeout(timeout);
          release();
          if (!expired) reject(error);
        }
      );
  });

  let disposed = false;
  let streamStarted = false;
  let consuming = false;
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let disposalError: Error | undefined;
  const finish = (error?: Error) => {
    // A callback can hold copies or an in-flight transfer that a timer cannot revoke.
    if (disposed || consuming) return;
    disposed = true;
    disposalError = error;
    clearTimeout(egressTimeout);
    if (controller) {
      controller.error(error ?? errors.internal('Library download disposed'));
      controller = undefined;
    }
    try {
      releaseArrayBuffer(value.data);
    } finally {
      release();
    }
  };
  const egressTimeout = setTimeout(
    () => finish(errors.internal('Library download timed out')),
    timeoutMs
  );
  return {
    value,
    dispose: () => finish(errors.internal('Library download disposed')),
    consume: async <R>(operation: (loaded: T) => Promise<R>): Promise<R> => {
      if (disposed) throw disposalError ?? errors.internal('Library download disposed');
      if (streamStarted || consuming)
        throw errors.internal('Library download consumer already created');
      consuming = true;
      clearTimeout(egressTimeout);
      try {
        return await operation(value);
      } finally {
        consuming = false;
        finish();
      }
    },
    stream: (start = 0, endExclusive = value.data.byteLength) => {
      if (disposed) throw disposalError ?? errors.internal('Library download disposed');
      if (streamStarted || consuming)
        throw errors.internal('Library download stream already created');
      if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(endExclusive) ||
        start < 0 ||
        endExclusive < start ||
        endExclusive > value.data.byteLength
      ) {
        throw errors.badRequest('Invalid Library download range');
      }
      streamStarted = true;
      let offset = start;
      return new ReadableStream<Uint8Array>(
        {
          start(active) {
            controller = active;
          },
          pull(active) {
            if (disposed) return;
            if (offset < endExclusive) {
              const end = Math.min(offset + 64 * 1024, endExclusive);
              // Copy only this egress chunk: queued views must never pin the full file.
              active.enqueue(new Uint8Array(value.data.slice(offset, end)));
              offset = end;
            }
            if (offset === endExclusive) {
              active.close();
              controller = undefined;
              finish();
            }
          },
          cancel() {
            controller = undefined;
            finish();
          },
        },
        { highWaterMark: 0 }
      );
    },
  };
}
