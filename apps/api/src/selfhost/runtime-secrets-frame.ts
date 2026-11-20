/**
 * The key agent's wire format (deploy/selfhost/key-agent/server.ts speaks the other side), and the
 * error the Worker's secrets loader (runtime-secrets.ts) fails with. No socket here: the loader
 * owns the connection.
 */

export class RuntimeSecretsUnavailableError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'RuntimeSecretsUnavailableError';
    this.code = code;
  }
}

/**
 * First bytes of every request on the agent's socket (deploy/selfhost/key-agent/server.ts has the
 * same constant; apps/api/tests/unit/selfhost-sealed-secrets-contract.test.ts pins both). NUL
 * first: no HTTP request line can start with it.
 */
export const KEY_AGENT_PREAMBLE = '\u0000SAMKA2\n';
/** Largest answer accepted: a bundle holds a few dozen secrets of a few KiB at most. */
export const MAX_KEY_AGENT_RESPONSE_BYTES = 1024 * 1024;

/** A request frame: the preamble, a 4-byte big-endian length, then the JSON body. */
export function encodeKeyAgentFrame(body: string, preamble = KEY_AGENT_PREAMBLE): Uint8Array {
  const head = new TextEncoder().encode(preamble);
  const json = new TextEncoder().encode(body);
  const frame = new Uint8Array(head.length + 4 + json.length);
  frame.set(head, 0);
  new DataView(frame.buffer).setUint32(head.length, json.length);
  frame.set(json, head.length + 4);
  return frame;
}

/** Reads one length-prefixed answer, refusing anything larger than the cap. */
export async function readFrame(readable: ReadableStream<Uint8Array>): Promise<string> {
  const reader = readable.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  let expected = -1;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (value) {
        chunks.push(value);
        received += value.length;
      }
      if (expected < 0 && received >= 4) {
        const all = concat(chunks, received);
        expected = new DataView(all.buffer, all.byteOffset, 4).getUint32(0);
        if (expected > MAX_KEY_AGENT_RESPONSE_BYTES) {
          throw new RuntimeSecretsUnavailableError(
            'KEY_AGENT_BAD_RESPONSE',
            'key agent answer is larger than allowed'
          );
        }
      }
      if (expected >= 0 && received >= 4 + expected) {
        const all = concat(chunks, received);
        return new TextDecoder().decode(all.subarray(4, 4 + expected));
      }
      if (done) {
        throw new RuntimeSecretsUnavailableError(
          'KEY_AGENT_BAD_RESPONSE',
          'key agent closed the connection before answering'
        );
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function concat(chunks: Uint8Array[], length: number): Uint8Array {
  const out = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
