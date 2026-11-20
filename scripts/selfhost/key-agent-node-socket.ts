/**
 * A Node `node:net` socket in the shape of a `cloudflare:sockets` socket, for running the Worker's
 * runtime-secrets loader outside celld (the migration's contract check, secrets-preflight.ts).
 */
import { connect } from 'node:net';
import { Duplex } from 'node:stream';

export interface NodeKeyAgentSocket {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  close(): Promise<void>;
}

export function nodeKeyAgentSocket(address: { hostname: string; port: number }): NodeKeyAgentSocket {
  const raw = connect({ host: address.hostname, port: address.port });
  const web = Duplex.toWeb(raw) as unknown as {
    readable: ReadableStream<Uint8Array>;
    writable: WritableStream<Uint8Array>;
  };
  return {
    readable: web.readable,
    writable: web.writable,
    close: async () => {
      raw.destroy();
    },
  };
}
