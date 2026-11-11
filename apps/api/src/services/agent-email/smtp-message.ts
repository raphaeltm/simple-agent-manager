/**
 * Builds the RFC 5322 message the SMTP sender transmits after DATA.
 *
 * Every value that lands in a header is checked: a CR or LF in a subject, name or extra header
 * would let the caller add headers or recipients (header injection), so it is refused rather than
 * stripped. Non-ASCII subjects and display names become RFC 2047 encoded words, and a body that
 * is not plain 7-bit ASCII (or has a line over the RFC 5322 limit) is sent as base64 UTF-8, so
 * the message never needs the relay's 8BITMIME or SMTPUTF8 support.
 */
import type { OutboundAgentEmail } from './provider';
import { isSmtpAddress } from './smtp-config';

/** RFC 5322 hard limit on a line, excluding CRLF. */
const MAX_LINE_LENGTH = 998;
/** RFC 2045 limit on a base64 line. */
const BASE64_LINE_LENGTH = 76;

/** Headers the builder owns; a caller-supplied header may not replace or repeat them. */
const RESERVED_HEADERS = new Set([
  'from',
  'to',
  'cc',
  'bcc',
  'subject',
  'date',
  'message-id',
  'mime-version',
  'content-type',
  'content-transfer-encoding',
  'sender',
  'reply-to',
  'return-path',
]);

const HEADER_NAME = /^[!-9;-~]+$/;
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const LINE_BREAK_OR_NUL = /[\r\n\0]/;

export class SmtpMessageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SmtpMessageError';
  }
}

function base64Utf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** A header value: refused if it could break the header block, encoded if not ASCII. */
function headerText(value: string, field: string): string {
  if (LINE_BREAK_OR_NUL.test(value)) throw new SmtpMessageError(`${field} contains a line break`);
  return PRINTABLE_ASCII.test(value) ? value : `=?UTF-8?B?${base64Utf8(value)}?=`;
}

function address(value: string, field: string): string {
  if (!isSmtpAddress(value)) throw new SmtpMessageError(`${field} is not a plain email address`);
  return value;
}

function mailbox(email: string, name: string): string {
  const addr = address(email, 'from.email');
  if (!name) return addr;
  const display =
    PRINTABLE_ASCII.test(name) && !LINE_BREAK_OR_NUL.test(name)
      ? `"${name.replace(/[\\"]/g, '\\$&')}"`
      : headerText(name, 'from.name');
  return `${display} <${addr}>`;
}

function extraHeaders(headers: Record<string, string>): string[] {
  return Object.entries(headers).map(([name, value]) => {
    if (!HEADER_NAME.test(name) || RESERVED_HEADERS.has(name.toLowerCase())) {
      throw new SmtpMessageError(`header ${JSON.stringify(name)} is not allowed`);
    }
    return `${name}: ${headerText(value, `header ${name}`)}`;
  });
}

function body(text: string): { encoding: '7bit' | 'base64'; lines: string[] } {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const plain = lines.every(
    (line) => line.length <= MAX_LINE_LENGTH && /^[\x20-\x7e\t]*$/.test(line)
  );
  if (plain) return { encoding: '7bit', lines };
  const encoded = base64Utf8(lines.join('\r\n'));
  const wrapped: string[] = [];
  for (let at = 0; at < encoded.length; at += BASE64_LINE_LENGTH) {
    wrapped.push(encoded.slice(at, at + BASE64_LINE_LENGTH));
  }
  return { encoding: 'base64', lines: wrapped };
}

export interface BuiltMessage {
  /** The envelope sender (MAIL FROM) and recipient (RCPT TO). */
  envelopeFrom: string;
  envelopeTo: string;
  /** Header block and body joined with CRLF, without the DATA terminator or dot-stuffing. */
  data: string;
}

export function buildSmtpMessage(
  message: OutboundAgentEmail,
  options: { now: Date; messageId: string }
): BuiltMessage {
  const to = address(message.to, 'to');
  const from = mailbox(message.from.email, message.from.name);
  const { encoding, lines } = body(message.text);
  const headers = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${headerText(message.subject, 'subject')}`,
    `Date: ${options.now.toUTCString().replace(/GMT$/, '+0000')}`,
    `Message-ID: <${options.messageId}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    `Content-Transfer-Encoding: ${encoding}`,
    ...extraHeaders(message.headers),
  ];
  return {
    envelopeFrom: message.from.email,
    envelopeTo: to,
    data: [...headers, '', ...lines].join('\r\n'),
  };
}

/**
 * The DATA payload: lines starting with "." get a second one (RFC 5321 4.5.2), then the
 * terminating CRLF.CRLF.
 */
export function dotStuff(data: string): string {
  return `${data.replace(/(^|\r\n)\./g, '$1..')}\r\n.\r\n`;
}
