/**
 * Bounded request-body reading for the hosted git Durable Object: pkt-line lengths, whole-body
 * reads with a byte cap, and draining a refused upload so the client sees the refusal reason.
 */
import { readGitChunk } from '../../vendor/dgit/git/budget';
import { concat, td } from '../../vendor/dgit/git/util';

const PKT_LENGTH = /^[0-9a-f]{4}$/i;

export class RequestTooLargeError extends Error {
  constructor() {
    super('request body exceeds maximum size');
  }
}

/**
 * A pkt-line length: exactly four hex digits. 0 is a flush packet; 1-3 are invalid. `parseInt`
 * alone would accept "-004" and walk the parser backwards forever (security review, HIGH).
 */
export function pktLength(bytes: Uint8Array): number {
  const text = td.decode(bytes);
  if (!PKT_LENGTH.test(text)) throw new Error('bad pkt-line in push request');
  const len = parseInt(text, 16);
  if (len !== 0 && len < 4) throw new Error('bad pkt-line in push request');
  return len;
}

/** Read a whole request body, refusing (without buffering further) past `maxBytes`. */
export async function readBodyBounded(req: Request, maxBytes: number): Promise<Uint8Array> {
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await readGitChunk(reader);
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new RequestTooLargeError();
    }
    parts.push(value);
  }
  return concat(parts);
}

/** Discard up to `maxBytes` of a request body, then cancel whatever is left. */
export async function drainBounded(
  reader: ReadableStreamDefaultReader<Uint8Array> | null,
  maxBytes: number
): Promise<void> {
  if (!reader) return;
  let drained = 0;
  try {
    while (drained <= maxBytes) {
      const { done, value } = await readGitChunk(reader);
      if (done) return;
      drained += value?.byteLength ?? 0;
    }
    await reader.cancel();
  } catch {
    // The client may already be gone.
  }
}

/**
 * A byte buffer that grows geometrically as chunks arrive, so reading a body in many small chunks
 * copies O(total) bytes rather than re-copying everything read so far on every chunk.
 */
export class ChunkBuffer {
  private bytes: Uint8Array;
  length: number;
  /** Bytes copied so far, for tests that bound the work. */
  copied = 0;

  constructor(initial: Uint8Array = new Uint8Array(0)) {
    this.bytes = initial;
    this.length = initial.length;
  }

  append(chunk: Uint8Array): void {
    if (this.length + chunk.length > this.bytes.length) {
      const grown = new Uint8Array(
        Math.max(this.bytes.length * 2, this.length + chunk.length, 4096)
      );
      grown.set(this.bytes.subarray(0, this.length));
      this.copied += this.length;
      this.bytes = grown;
    }
    this.bytes.set(chunk, this.length);
    this.length += chunk.length;
    this.copied += chunk.length;
  }

  /** The bytes in [start, end), clamped to what has been read. */
  view(start = 0, end = this.length): Uint8Array {
    return this.bytes.subarray(start, Math.min(end, this.length));
  }
}
