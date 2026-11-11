/**
 * A small real SMTP server on 127.0.0.1 for tests: plaintext, STARTTLS or implicit TLS, optional
 * AUTH PLAIN, and a record of every command and accepted message. Certificates come from
 * `createTestTlsCertificates` (openssl), so the TLS paths verify a real chain and hostname.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import tls from 'node:tls';

export interface TestTlsCertificates {
  ca: string;
  key: string;
  cert: string;
}

/** A throwaway CA and a server certificate for `names` (DNS) plus 127.0.0.1. */
export function createTestTlsCertificates(names: string[]): TestTlsCertificates {
  const dir = mkdtempSync(join(tmpdir(), 'sam-smtp-tls-'));
  const openssl = (args: string[]) => execFileSync('openssl', args, { cwd: dir, stdio: 'pipe' });
  try {
    openssl([
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      'ca.key',
      '-out',
      'ca.pem',
      '-days',
      '2',
      '-subj',
      '/CN=SAM test CA',
      '-addext',
      'basicConstraints=critical,CA:TRUE',
      '-addext',
      'keyUsage=critical,keyCertSign',
    ]);
    openssl([
      'req',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      'server.key',
      '-out',
      'server.csr',
      '-subj',
      `/CN=${names[0]}`,
    ]);
    const san = [...names.map((name) => `DNS:${name}`), 'IP:127.0.0.1'].join(',');
    writeFileSync(join(dir, 'ext.cnf'), `subjectAltName=${san}\nextendedKeyUsage=serverAuth\n`);
    openssl([
      'x509',
      '-req',
      '-in',
      'server.csr',
      '-CA',
      'ca.pem',
      '-CAkey',
      'ca.key',
      '-CAcreateserial',
      '-out',
      'server.pem',
      '-days',
      '2',
      '-extfile',
      'ext.cnf',
    ]);
    const read = (name: string) => readFileSync(join(dir, name), 'utf8');
    return { ca: read('ca.pem'), key: read('server.key'), cert: read('server.pem') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export interface FakeSmtpOptions {
  mode: 'plain' | 'starttls' | 'implicit';
  tls?: TestTlsCertificates;
  /** Offer STARTTLS in EHLO (default: true in starttls mode). */
  offerStartTls?: boolean;
  /** Required AUTH PLAIN credentials; unset means no AUTH is advertised. */
  credentials?: { username: string; password: string };
  /** Reply code for RCPT TO (default 250). */
  rcptCode?: number;
  /** Extra bytes sent right after "220 Ready to start TLS" (STARTTLS injection). */
  injectAfterStartTls?: string;
  /** Never answer the greeting (deadline tests). */
  silent?: boolean;
}

export interface ReceivedMessage {
  from: string;
  to: string[];
  /** DATA after removing dot-stuffing and the terminator. */
  data: string;
  /** Whether the transaction ran over TLS. */
  secure: boolean;
  authenticatedAs: string | null;
}

export interface FakeSmtpServer {
  port: number;
  messages: ReceivedMessage[];
  /** Every command line received, with AUTH payloads replaced. */
  commands: string[];
  close(): Promise<void>;
}

export async function startFakeSmtpServer(options: FakeSmtpOptions): Promise<FakeSmtpServer> {
  const messages: ReceivedMessage[] = [];
  const commands: string[] = [];
  const secureContext = options.tls
    ? tls.createSecureContext({ key: options.tls.key, cert: options.tls.cert })
    : undefined;

  const handle = (initial: net.Socket, initiallySecure: boolean) => {
    let socket: net.Socket = initial;
    let secure = initiallySecure;
    let buffer = '';
    let inData = false;
    let dataLines: string[] = [];
    let from = '';
    let to: string[] = [];
    let user: string | null = null;
    const write = (line: string) => socket.write(`${line}\r\n`);
    const offerStartTls = options.mode === 'starttls' && (options.offerStartTls ?? true);

    const onLine = (line: string) => {
      if (inData) {
        if (line === '.') {
          inData = false;
          messages.push({ from, to, data: dataLines.join('\r\n'), secure, authenticatedAs: user });
          write('250 2.0.0 queued');
        } else dataLines.push(line.startsWith('.') ? line.slice(1) : line);
        return;
      }
      commands.push(line.replace(/^AUTH PLAIN \S+/i, 'AUTH PLAIN <redacted>'));
      const verb = line.split(' ', 1)[0]?.toUpperCase();
      if (verb === 'EHLO') {
        const ext = ['250-fake.example.com'];
        if (offerStartTls && !secure) ext.push('250-STARTTLS');
        if (options.credentials) ext.push('250-AUTH PLAIN LOGIN');
        ext.push('250 8BITMIME');
        ext.forEach(write);
      } else if (verb === 'STARTTLS' && offerStartTls && !secure) {
        write(`220 2.0.0 Ready to start TLS${options.injectAfterStartTls ?? ''}`);
        socket.removeAllListeners('data');
        const upgraded = new tls.TLSSocket(socket, { isServer: true, secureContext });
        socket = upgraded;
        secure = true;
        buffer = '';
        upgraded.on('data', onData);
        upgraded.on('error', () => undefined);
      } else if (verb === 'AUTH') {
        const decoded = Buffer.from(line.split(' ')[2] ?? '', 'base64').toString('utf8');
        const [, username, password] = decoded.split('\0');
        const ok =
          options.credentials?.username === username && options.credentials?.password === password;
        if (ok) user = username ?? null;
        write(ok ? '235 2.7.0 Authenticated' : '535 5.7.8 Bad credentials');
      } else if (verb === 'MAIL') {
        from = /<(.*)>/.exec(line)?.[1] ?? '';
        to = [];
        write('250 2.1.0 OK');
      } else if (verb === 'RCPT') {
        to.push(/<(.*)>/.exec(line)?.[1] ?? '');
        write(`${options.rcptCode ?? 250} 2.1.5 recipient`);
      } else if (verb === 'DATA') {
        inData = true;
        dataLines = [];
        write('354 End data with <CR><LF>.<CR><LF>');
      } else if (verb === 'QUIT') {
        write('221 2.0.0 Bye');
        socket.end();
      } else write('502 5.5.2 Command not recognized');
    };
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let end: number;
      while ((end = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        onLine(line);
      }
    };
    socket.on('data', onData);
    socket.on('error', () => undefined);
    if (!options.silent) write('220 fake.example.com ESMTP test');
  };

  const server =
    options.mode === 'implicit'
      ? tls.createServer({ key: options.tls?.key, cert: options.tls?.cert }, (s) => handle(s, true))
      : net.createServer((s) => handle(s, false));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  const sockets = new Set<net.Socket>();
  server.on('connection', (s: net.Socket) => sockets.add(s));
  return {
    port: address.port,
    messages,
    commands,
    async close() {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
