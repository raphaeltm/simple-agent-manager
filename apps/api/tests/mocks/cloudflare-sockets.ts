/**
 * `cloudflare:sockets` for Node test runs, over real `node:net` / `node:tls` sockets, so SMTP
 * code is exercised against a real TCP server rather than a scripted stream.
 *
 * Mirrors the runtime contract the SMTP client relies on: `readable`/`writable` web streams,
 * `secureTransport` 'off' | 'on' | 'starttls', `startTls({ expectedServerHostname })` returning a
 * new socket, chain and hostname verification. Tests that run a TLS server add its CA with
 * `__setTestTlsCa`; nothing else is trusted then (celld also trusts only a fixed root set).
 */
import net from 'node:net';
import tls from 'node:tls';

let testCa: string | undefined;

export function __setTestTlsCa(ca: string | undefined): void {
  testCa = ca;
}

interface SocketAddress {
  hostname: string;
  port: number;
}

interface SocketOptions {
  secureTransport?: string;
  allowHalfOpen: boolean;
}

class NodeBackedSocket {
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;
  readonly opened: Promise<{ remoteAddress?: string }>;
  readonly closed: Promise<void>;

  constructor(
    private readonly raw: net.Socket,
    readonly secureTransport: 'on' | 'off' | 'starttls',
    private readonly hostname: string,
    readyEvent: 'connect' | 'secureConnect'
  ) {
    this.opened = new Promise((resolve, reject) => {
      raw.once(readyEvent, () => resolve({ remoteAddress: raw.remoteAddress }));
      raw.once('error', reject);
    });
    this.closed = new Promise((resolve) => raw.once('close', () => resolve()));
    this.opened.catch(() => undefined);
    const onData = (chunk: Buffer) => controller?.enqueue(new Uint8Array(chunk));
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    this.readable = new ReadableStream<Uint8Array>({
      start: (c) => {
        controller = c;
        raw.on('data', onData);
        raw.once('end', () => c.close());
        raw.once('error', (error) => c.error(error));
      },
      cancel: () => {
        raw.off('data', onData);
      },
    });
    this.writable = new WritableStream<Uint8Array>({
      write: async (chunk) => {
        await this.opened;
        await new Promise<void>((resolve, reject) =>
          raw.write(chunk, (error) => (error ? reject(error) : resolve()))
        );
      },
    });
  }

  get upgraded(): boolean {
    return false;
  }

  startTls(options?: { expectedServerHostname?: string }): NodeBackedSocket {
    if (this.secureTransport !== 'starttls') {
      throw new TypeError("secureTransport must be 'starttls' for startTls");
    }
    this.raw.removeAllListeners('data');
    this.raw.removeAllListeners('end');
    const servername = options?.expectedServerHostname ?? this.hostname;
    const secure = tls.connect({ socket: this.raw, servername, ca: testCa });
    return new NodeBackedSocket(secure, 'on', servername, 'secureConnect');
  }

  async close(): Promise<void> {
    this.raw.destroy();
  }
}

export function connect(address: SocketAddress, options?: SocketOptions): NodeBackedSocket {
  const mode = (options?.secureTransport ?? 'off') as 'on' | 'off' | 'starttls';
  if (mode === 'on') {
    const raw = tls.connect({
      host: address.hostname,
      port: address.port,
      servername: net.isIP(address.hostname) ? undefined : address.hostname,
      ca: testCa,
    });
    return new NodeBackedSocket(raw, 'on', address.hostname, 'secureConnect');
  }
  const raw = net.connect({ host: address.hostname, port: address.port });
  return new NodeBackedSocket(raw, mode, address.hostname, 'connect');
}
