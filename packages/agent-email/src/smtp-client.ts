/**
 * A minimal SMTP submission client over `cloudflare:sockets` (Cloudflare Workers and celld both
 * provide it): EHLO, STARTTLS or implicit TLS, AUTH PLAIN, one message to one recipient, QUIT.
 *
 * Fail closed:
 * - with SMTP_TLS=starttls a server that does not offer STARTTLS is refused, never used in
 *   plaintext, and bytes the server sent ahead of the TLS handshake are treated as an injection
 *   attempt (RFC 3207 section 6);
 * - the runtime verifies the certificate chain and the configured hostname;
 * - credentials are sent only over TLS, or over plaintext to a loopback host (smtp-config.ts);
 * - the whole exchange has one deadline, after which the socket is closed.
 */
import { connect } from 'cloudflare:sockets';

import type { SmtpConfig } from './smtp-config';
import { dotStuff } from './smtp-message';

export type SmtpConnect = typeof connect;

/** Longest single server reply accepted; real replies are a few hundred bytes. */
const MAX_REPLY_BYTES = 64 * 1024;
/** Most lines in one multi-line reply; EHLO answers with a few dozen at most. */
const MAX_REPLY_LINES = 100;

export class SmtpError extends Error {
  constructor(
    message: string,
    /** The server's reply code when the failure was a refusal; null for transport failures. */
    readonly replyCode: number | null = null
  ) {
    super(message);
    this.name = 'SmtpError';
  }
}

interface Reply {
  code: number;
  lines: string[];
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** One socket's reader and writer, recreated by `upgrade` after STARTTLS. */
class SmtpConnection {
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private writer: WritableStreamDefaultWriter<Uint8Array>;
  private buffer = '';

  constructor(private socket: Socket) {
    this.reader = socket.readable.getReader() as ReadableStreamDefaultReader<Uint8Array>;
    this.writer = socket.writable.getWriter() as WritableStreamDefaultWriter<Uint8Array>;
  }

  async reply(): Promise<Reply> {
    const lines: string[] = [];
    let bytes = 0;
    for (;;) {
      const end = this.buffer.indexOf('\r\n');
      if (end < 0) {
        await this.fill();
        continue;
      }
      const line = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 2);
      const match = /^(\d{3})([ -])(.*)$/.exec(line);
      if (!match) throw new SmtpError('malformed SMTP reply');
      const code = Number(match[1]);
      if (lines.length > 0 && code !== Number(lines[0]?.slice(0, 3))) {
        throw new SmtpError('inconsistent SMTP reply codes');
      }
      lines.push(line);
      bytes += line.length + 2;
      if (bytes > MAX_REPLY_BYTES || lines.length > MAX_REPLY_LINES) {
        throw new SmtpError('SMTP reply too long');
      }
      if (match[2] === ' ') return { code, lines: lines.map((entry) => entry.slice(4)) };
    }
  }

  private async fill(): Promise<void> {
    if (this.buffer.length > MAX_REPLY_BYTES) throw new SmtpError('SMTP reply too long');
    const { value, done } = await this.reader.read();
    if (done) throw new SmtpError('SMTP server closed the connection');
    this.buffer += decoder.decode(value, { stream: true });
  }

  async send(line: string): Promise<void> {
    await this.writer.write(encoder.encode(line));
  }

  async command(line: string, expected: readonly number[], step: string): Promise<Reply> {
    await this.send(`${line}\r\n`);
    return expect(await this.reply(), expected, step);
  }

  /** STARTTLS: refuses if the server already sent more (plaintext injected before TLS). */
  upgrade(hostname: string): void {
    if (this.buffer.length > 0) throw new SmtpError('SMTP server sent data before TLS started');
    this.reader.releaseLock();
    this.writer.releaseLock();
    this.socket = this.socket.startTls({ expectedServerHostname: hostname });
    this.reader = this.socket.readable.getReader() as ReadableStreamDefaultReader<Uint8Array>;
    this.writer = this.socket.writable.getWriter() as WritableStreamDefaultWriter<Uint8Array>;
  }

  close(): void {
    this.socket.close().catch(() => undefined);
  }
}

function expect(reply: Reply, expected: readonly number[], step: string): Reply {
  if (!expected.includes(reply.code)) {
    // The server's text is not included: it can echo addresses back.
    throw new SmtpError(`SMTP ${step} refused with ${reply.code}`, reply.code);
  }
  return reply;
}

/** EHLO keywords (upper-cased) with their parameters. */
function extensions(reply: Reply): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of reply.lines.slice(1)) {
    const [keyword = '', ...rest] = line.trim().split(/\s+/);
    map.set(keyword.toUpperCase(), rest.join(' ').toUpperCase());
  }
  return map;
}

function authPlain(username: string, password: string): string {
  const bytes = encoder.encode(`\0${username}\0${password}`);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export interface SmtpDelivery {
  envelopeFrom: string;
  envelopeTo: string;
  /** The message without dot-stuffing or terminator (smtp-message.ts). */
  data: string;
}

export interface SmtpSendOptions {
  timeoutMs: number;
  /** The name SAM introduces itself with in EHLO. */
  heloName: string;
  /** Tests substitute the socket; production uses `cloudflare:sockets`. */
  connectSocket?: SmtpConnect;
}

async function converse(
  connection: SmtpConnection,
  config: SmtpConfig,
  delivery: SmtpDelivery,
  heloName: string
): Promise<void> {
  expect(await connection.reply(), [220], 'greeting');
  let ehlo = await connection.command(`EHLO ${heloName}`, [250], 'EHLO');
  if (config.tls === 'starttls') {
    if (!extensions(ehlo).has('STARTTLS'))
      throw new SmtpError('SMTP server does not offer STARTTLS');
    await connection.command('STARTTLS', [220], 'STARTTLS');
    connection.upgrade(config.host);
    ehlo = await connection.command(`EHLO ${heloName}`, [250], 'EHLO after STARTTLS');
  }
  if (config.credentials) {
    const mechanisms = (extensions(ehlo).get('AUTH') ?? '').split(' ');
    if (!mechanisms.includes('PLAIN')) throw new SmtpError('SMTP server does not offer AUTH PLAIN');
    const { username, password } = config.credentials;
    await connection.command(`AUTH PLAIN ${authPlain(username, password)}`, [235], 'AUTH');
  }
  await connection.command(`MAIL FROM:<${delivery.envelopeFrom}>`, [250], 'MAIL FROM');
  await connection.command(`RCPT TO:<${delivery.envelopeTo}>`, [250, 251], 'RCPT TO');
  await connection.command('DATA', [354], 'DATA');
  await connection.send(dotStuff(delivery.data));
  expect(await connection.reply(), [250], 'message');
  // The message is accepted; a failed QUIT changes nothing.
  await connection.command('QUIT', [221], 'QUIT').catch(() => undefined);
}

/** Sends one message. Throws `SmtpError` on refusal, transport failure or the deadline. */
export async function sendSmtpMessage(
  config: SmtpConfig,
  delivery: SmtpDelivery,
  options: SmtpSendOptions
): Promise<void> {
  const open = options.connectSocket ?? connect;
  const socket = open(
    { hostname: config.host, port: config.port },
    {
      secureTransport: config.tls === 'tls' ? 'on' : config.tls === 'starttls' ? 'starttls' : 'off',
      allowHalfOpen: false,
    }
  );
  const connection = new SmtpConnection(socket);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new SmtpError(`SMTP exchange timed out after ${options.timeoutMs} ms`)),
      options.timeoutMs
    );
  });
  try {
    await Promise.race([converse(connection, config, delivery, options.heloName), deadline]);
  } catch (error) {
    if (error instanceof SmtpError) throw error;
    // Socket and TLS errors (refused, unreachable, certificate) carry no secrets.
    throw new SmtpError(error instanceof Error ? error.message : String(error));
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    connection.close();
  }
}
