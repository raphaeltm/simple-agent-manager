/** Preserve existing senders when Email Routing needs an apex SPF record. */
import {
  comparableDnsContent,
  isSpfRecord,
  type MailDnsRecord,
} from '@simple-agent-manager/shared';

const ROUTING_INCLUDE = 'include:_spf.mx.cloudflare.net';
const GOOGLE_INCLUDE = 'include:_spf.google.com';
const GOOGLE_MX = /^(?:smtp\.google\.com|(?:alt[1-4]\.)?aspmx\.l\.google\.com)\.?$/i;

export function planRoutingSpf(
  records: MailDnsRecord[]
): { before: string | null; after: string } | { reason: string } {
  const spf = records.filter(isSpfRecord);
  if (spf.length > 1)
    return {
      reason:
        'The main domain has multiple SPF records. Resolve that conflict before enabling agent email.',
    };
  if (spf.length === 0) {
    const mx = records.filter((record) => record.type === 'MX');
    if (mx.some((record) => !GOOGLE_MX.test(record.content))) {
      return {
        reason:
          'The main domain receives mail but has no SPF record. Add an SPF record authorizing your existing mail provider before enabling agent email.',
      };
    }
    const senders = mx.length ? [GOOGLE_INCLUDE, ROUTING_INCLUDE] : [ROUTING_INCLUDE];
    return { before: null, after: ['v=spf1', ...senders, '~all'].join(' ') };
  }
  const existing = spf[0];
  if (!existing) throw new Error('Missing inspected SPF record');
  const before = comparableDnsContent(existing);
  const terms = before.split(/\s+/);
  // Redirects and permissive all mechanisms need an explicit operator decision; never
  // rewrite their meaning while trying to add another sender.
  if (!/^[~-]all$/i.test(terms.at(-1) ?? '') || terms.some((term) => /^redirect=/i.test(term))) {
    return {
      reason:
        'The existing SPF policy cannot be safely verified automatically. Review its redirect and terminal all mechanism before enabling agent email.',
    };
  }
  if (terms.some((term) => term.toLowerCase() === ROUTING_INCLUDE))
    return { before, after: before };
  return { before, after: [...terms.slice(0, -1), ROUTING_INCLUDE, terms.at(-1)].join(' ') };
}
