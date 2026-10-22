/**
 * Provider-neutral view of an inbound email. The Cloudflare `email()` handler hands raw
 * MIME and the envelope here; nothing downstream sees Cloudflare or postal-mime types.
 */
import PostalMime from 'postal-mime';

import { normalizeMailbox } from './address';
import {
  parseMessageIdList,
  parseSingleMessageId,
  sanitizeDisplayName,
  sanitizeSubject,
} from './headers';

export interface InboundAttachmentSummary {
  filename: string;
  mimeType: string;
  size: number;
}

export interface InboundAgentEmail {
  envelopeFrom: string;
  envelopeTo: string;
  /** Lower-cased `From:` mailbox, or null when the header is missing or malformed. */
  from: string | null;
  fromName: string;
  subject: string;
  messageId: string | null;
  /** The message this one replies to, when it says so. */
  inReplyTo: string | null;
  references: string[];
  text: string;
  textTruncated: boolean;
  attachments: InboundAttachmentSummary[];
  autoSubmitted: string | null;
  precedence: string | null;
  hasListId: boolean;
}

export interface InboundEnvelope {
  from: string;
  to: string;
}

/** Bounds postal-mime's own parsing work for one message. */
const PARSE_LIMITS = {
  maxNestingDepth: 32,
  maxPartCount: 500,
  maxRfc822NestingDepth: 2,
  maxForwardedAddresses: 500,
  attachmentEncoding: 'arraybuffer',
} as const;

/** Elements whose content is never text. */
const SKIPPED_ELEMENTS = new Set(['head', 'script', 'style']);
/** Elements whose end starts a new line. */
const BLOCK_ELEMENTS = new Set([
  'p',
  'div',
  'li',
  'tr',
  'blockquote',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
]);
const TAG_NAME = /^(\/?)([a-z][a-z0-9]*)/i;
const NAMED_ENTITIES = new Map([
  ['amp', '&'],
  ['lt', '<'],
  ['gt', '>'],
  ['quot', '"'],
  ['apos', "'"],
  ['nbsp', ' '],
]);
const ENTITY = /&(?:#(\d{1,7})|#x([\da-f]{1,6})|([a-z]{2,6}));/gi;

function decodeEntity(match: string, decimal?: string, hex?: string, name?: string): string {
  if (name) return NAMED_ENTITIES.get(name.toLowerCase()) ?? match;
  const codePoint = decimal ? Number(decimal) : Number.parseInt(hex ?? '', 16);
  const valid =
    codePoint > 0 && codePoint <= 0x10ffff && (codePoint < 0xd800 || codePoint > 0xdfff);
  return valid ? String.fromCodePoint(codePoint) : match;
}

/** Where the `</name` that ends a skipped element starts, or -1. Case-insensitive. */
function findEndTag(html: string, name: string, from: number): number {
  for (let at = html.indexOf('</', from); at !== -1; at = html.indexOf('</', at + 2)) {
    if (html.slice(at + 2, at + 2 + name.length).toLowerCase() === name) return at;
  }
  return -1;
}

/**
 * Plain text from HTML in one forward pass. Regex replacement over attacker-supplied markup
 * goes quadratic (unclosed tags, long runs of `<` or spaces), so tags are found with indexOf
 * and every character is scanned a bounded number of times. No regex here backtracks.
 */
function htmlToText(html: string): string {
  let text = '';
  let index = 0;
  while (index < html.length) {
    const open = html.indexOf('<', index);
    if (open === -1) {
      text += html.slice(index);
      break;
    }
    text += html.slice(index, open);
    if (html.startsWith('<!--', open)) {
      const end = html.indexOf('-->', open + 4);
      if (end === -1) break;
      index = end + 3;
      continue;
    }
    const close = html.indexOf('>', open + 1);
    // An unterminated tag runs to the end of the document, so none of the rest is text.
    if (close === -1) break;
    index = close + 1;
    const tag = TAG_NAME.exec(html.slice(open + 1, close));
    if (!tag) continue;
    const slash = tag[1];
    const name = (tag[2] ?? '').toLowerCase();
    if (!slash && SKIPPED_ELEMENTS.has(name) && html[close - 1] !== '/') {
      const end = findEndTag(html, name, index);
      if (end === -1) break;
      const endClose = html.indexOf('>', end);
      index = endClose === -1 ? html.length : endClose + 1;
      text += ' ';
    } else if (name === 'br' || (slash && BLOCK_ELEMENTS.has(name))) {
      text += '\n';
    }
  }
  return text
    .replace(ENTITY, decodeEntity)
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function headerValue(headers: Array<{ key: string; value: string }>, key: string): string | null {
  return headers.find((header) => header.key === key)?.value.trim() ?? null;
}

function attachmentSize(content: ArrayBuffer | Uint8Array | string): number {
  return typeof content === 'string' ? content.length : content.byteLength;
}

export async function parseInboundEmail(
  raw: ReadableStream<Uint8Array> | ArrayBuffer | string,
  envelope: InboundEnvelope,
  maxBodyChars: number
): Promise<InboundAgentEmail> {
  const parsed = await PostalMime.parse(raw, PARSE_LIMITS);
  const sender = parsed.from && 'address' in parsed.from ? parsed.from : undefined;
  // The body is user content for the prompt, not a header: keep newlines, drop NULs.
  // eslint-disable-next-line no-control-regex -- stripping NUL is the point
  const body = (parsed.text ?? (parsed.html ? htmlToText(parsed.html) : '')).replace(/\u0000/g, '');
  const textTruncated = body.length > maxBodyChars;
  return {
    envelopeFrom: envelope.from.trim().toLowerCase(),
    envelopeTo: envelope.to.trim().toLowerCase(),
    from: normalizeMailbox(sender?.address),
    fromName: sanitizeDisplayName(sender?.name),
    subject: sanitizeSubject(parsed.subject),
    messageId: parseSingleMessageId(parsed.messageId),
    inReplyTo: parseSingleMessageId(parsed.inReplyTo),
    references: parseMessageIdList(parsed.references),
    text: textTruncated ? body.slice(0, maxBodyChars) : body,
    textTruncated,
    attachments: parsed.attachments.map((attachment) => ({
      filename: sanitizeDisplayName(attachment.filename) || 'unnamed',
      mimeType: sanitizeDisplayName(attachment.mimeType) || 'application/octet-stream',
      size: attachmentSize(attachment.content),
    })),
    autoSubmitted: headerValue(parsed.headers, 'auto-submitted')?.toLowerCase() ?? null,
    precedence: headerValue(parsed.headers, 'precedence')?.toLowerCase() ?? null,
    hasListId: headerValue(parsed.headers, 'list-id') !== null,
  };
}
