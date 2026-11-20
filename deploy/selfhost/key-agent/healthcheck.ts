/**
 * The compose healthcheck and the deploy's readiness check: one `ping` frame to the agent
 * (server.ts). Exits 0 when the agent answers, 1 otherwise. Carries no secret.
 *
 * Run with Node's type stripping: `node healthcheck.ts [port]`.
 */
import { connect } from 'node:net';

import { DEFAULT_KEY_AGENT_PORT, KEY_AGENT_PREAMBLE } from './server.ts';

/** Sends a ping; resolves the answer envelope's `sealed` flag, or rejects with a reason. */
export function pingKeyAgent(port: number, timeoutMs = 3000): Promise<{ sealed: boolean }> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port });
    let buffered = Buffer.alloc(0);
    const fail = (reason: string): void => {
      socket.destroy();
      reject(new Error(reason));
    };
    socket.setTimeout(timeoutMs, () => fail(`no answer within ${timeoutMs} ms`));
    socket.once('error', (error) => fail(error.message));
    socket.once('connect', () => {
      const body = Buffer.from(JSON.stringify({ op: 'ping' }), 'utf8');
      const length = Buffer.alloc(4);
      length.writeUInt32BE(body.length);
      socket.write(Buffer.concat([KEY_AGENT_PREAMBLE, length, body]));
    });
    socket.on('data', (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length < 4) return;
      const size = buffered.readUInt32BE(0);
      if (size > 4096) return fail('answer too large');
      if (buffered.length < 4 + size) return;
      socket.destroy();
      try {
        const parsed = JSON.parse(buffered.subarray(4, 4 + size).toString('utf8')) as unknown;
        if (typeof parsed !== 'object' || parsed === null) return reject(new Error('malformed answer'));
        const { status, sealed } = parsed as Record<string, unknown>;
        if (status !== 200) return reject(new Error(`answered ${String(status)}`));
        resolve({ sealed: sealed === true });
      } catch {
        reject(new Error('malformed answer'));
      }
    });
    socket.once('end', () => {
      if (buffered.length < 4) fail('closed without answering');
    });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.argv[2] ?? process.env.SAM_KEY_AGENT_PORT ?? DEFAULT_KEY_AGENT_PORT);
  pingKeyAgent(port).then(
    () => process.exit(0),
    () => process.exit(1)
  );
}
