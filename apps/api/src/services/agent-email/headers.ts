/**
 * Strict handling of values that cross from an inbound email into outbound headers, the
 * subject, or the agent prompt. Nothing from an email reaches a header unvalidated.
 */

/** RFC 5322 msg-id, conservatively: `<left@right>` with no spaces or brackets inside. */
const MESSAGE_ID_PATTERN = /^<[^<>\s@]{1,200}@[^<>\s@]{1,200}>$/;
const MESSAGE_ID_TOKEN = /<[^<>\s]{1,402}>/g;
const MAX_MESSAGE_ID_LENGTH = 404;
/** References kept on a reply; newest last. Cloudflare rejects replies past 100 entries. */
export const MAX_REFERENCES = 20;
export const MAX_SUBJECT_LENGTH = 300;
const MAX_DISPLAY_NAME_LENGTH = 100;

/** Remove control characters (CR/LF included), collapse whitespace, trim and cap. */
export function sanitizeHeaderText(value: string | null | undefined, maxLength: number): string {
  const cleaned = (value ?? '')
    // eslint-disable-next-line no-control-regex -- stripping control characters is the point
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length > maxLength ? cleaned.slice(0, maxLength).trimEnd() : cleaned;
}

export function sanitizeSubject(subject: string | null | undefined): string {
  return sanitizeHeaderText(subject, MAX_SUBJECT_LENGTH);
}

export function sanitizeDisplayName(name: string | null | undefined): string {
  return sanitizeHeaderText(name, MAX_DISPLAY_NAME_LENGTH).replace(/["\\<>]/g, '');
}

export function isValidMessageId(value: string): boolean {
  return value.length <= MAX_MESSAGE_ID_LENGTH && MESSAGE_ID_PATTERN.test(value);
}

/** Every valid msg-id in a header value, in order, without duplicates. */
export function parseMessageIdList(value: string | null | undefined): string[] {
  const ids: string[] = [];
  for (const match of (value ?? '').matchAll(MESSAGE_ID_TOKEN)) {
    const id = match[0];
    if (isValidMessageId(id) && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** The single msg-id of a Message-ID or In-Reply-To header, or null. */
export function parseSingleMessageId(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim();
  return isValidMessageId(trimmed) ? trimmed : null;
}

/** References for a reply: the original's references plus its own id, newest last. */
export function replyReferences(references: string[], messageId: string): string[] {
  const chain = [...references.filter((id) => id !== messageId), messageId];
  return chain.slice(-MAX_REFERENCES);
}

export function replySubject(subject: string): string {
  const base = sanitizeSubject(subject) || '(no subject)';
  return /^re:/i.test(base) ? base : sanitizeSubject(`Re: ${base}`);
}
