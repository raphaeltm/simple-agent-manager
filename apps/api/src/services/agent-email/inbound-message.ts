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

function htmlToText(html: string): string {
  return html
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/[ \t]+\n/g, '\n')
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
