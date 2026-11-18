/**
 * Comparing a domain's mail DNS records (MX and SPF) before and after an Email Routing or
 * Email Sending change. Used by the agent email deploy step and by the API's admin setup, so
 * both judge "the main domain changed" the same way. No imports: the deploy step loads this
 * file directly from source.
 */

export interface MailDnsRecord {
  type: string;
  name?: string;
  content: string;
  priority?: number;
}

/** Cloudflare Email Routing's inbound mail servers. */
export const CLOUDFLARE_ROUTING_MX_PATTERN = /\.mx\.cloudflare\.net\.?$/i;

/**
 * Comparable record content. A TXT value can be stored as several quoted strings, which
 * Cloudflare does for long values such as DKIM keys; its payload is the strings joined, compared
 * byte for byte because a DKIM key is case-sensitive. Host names (MX) compare without case or a
 * trailing dot.
 */
export function comparableDnsContent(record: Pick<MailDnsRecord, 'type' | 'content'>): string {
  const content = record.content.trim();
  if (record.type !== 'TXT') return content.replace(/\.$/, '').toLowerCase();
  const quoted = content.match(/"(?:[^"\\]|\\.)*"/g);
  return quoted ? quoted.map((chunk) => chunk.slice(1, -1)).join('') : content;
}

/** A TXT record whose first term is `v=spf1` (matched without case) is an SPF record. */
export function isSpfRecord(record: Pick<MailDnsRecord, 'type' | 'content'>): boolean {
  return record.type === 'TXT' && /^v=spf1(\s|$)/i.test(comparableDnsContent(record));
}

/** An MX record that points at Cloudflare Email Routing. */
export function isCloudflareRoutingMx(record: Pick<MailDnsRecord, 'type' | 'content'>): boolean {
  return record.type === 'MX' && CLOUDFLARE_ROUTING_MX_PATTERN.test(comparableDnsContent(record));
}

export function describeMailRecord(record: Pick<MailDnsRecord, 'type' | 'content'>): string {
  return `${record.type} ${comparableDnsContent(record)}`;
}

/** Identity of one MX/SPF record: type, priority and comparable content. */
export function mailRecordKey(record: MailDnsRecord): string {
  return `${record.type}:${record.priority ?? ''}:${comparableDnsContent(record)}`;
}

/** Order-independent identity of a set of MX/SPF records, so two reads can be compared. */
export function mailRecordSignature(records: MailDnsRecord[]): string {
  return records
    .map(mailRecordKey)
    .sort((a, b) => a.localeCompare(b))
    .join(',');
}

/** The records of `records` that `other` does not have, counting duplicates. */
export function mailRecordsMissingFrom(
  records: MailDnsRecord[],
  other: MailDnsRecord[]
): MailDnsRecord[] {
  const available = new Map<string, number>();
  for (const record of other) {
    const key = mailRecordKey(record);
    available.set(key, (available.get(key) ?? 0) + 1);
  }
  return records.filter((record) => {
    const key = mailRecordKey(record);
    const count = available.get(key) ?? 0;
    if (count === 0) return true;
    available.set(key, count - 1);
    return false;
  });
}
