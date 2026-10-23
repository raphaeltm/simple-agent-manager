/**
 * What the agent email setup changes outside `agents.<BASE_DOMAIN>`, how it compares the main
 * domain's mail records with a setup attempt's baseline, and the token that binds the admin's
 * consent to exactly the changes a plan listed.
 */
import {
  type AgentEmailMainDomainRecord,
  type AgentEmailSetupPlan,
  type AgentEmailZoneChange,
  comparableDnsContent,
  isSpfRecord,
  type MailDnsRecord,
  mailRecordsMissingFrom,
} from '@simple-agent-manager/shared';

import type { AgentEmailMailRecord, AgentEmailSetupAttempt } from './setup-state';

/** The SPF record Cloudflare adds to the root domain the first time a zone uses Email Routing. */
export const CLOUDFLARE_ROUTING_SPF = 'v=spf1 include:_spf.mx.cloudflare.net ~all';
/** The DKIM selector Cloudflare adds under the root domain at the same time. */
export const CLOUDFLARE_ROUTING_DKIM_SELECTOR = 'cf2024-1._domainkey';

/** The records Cloudflare adds to the main domain the first time a zone uses Email Routing. */
export function firstRoutingRecords(mainDomain: string): AgentEmailMainDomainRecord[] {
  return [
    { type: 'TXT', name: mainDomain, content: CLOUDFLARE_ROUTING_SPF, change: 'add' },
    // Cloudflare generates the key, so its content is not known in advance.
    {
      type: 'TXT',
      name: `${CLOUDFLARE_ROUTING_DKIM_SELECTOR}.${mainDomain}`,
      content: null,
      change: 'add',
    },
  ];
}

/** Subaddressing is a zone setting: it changes how every address in the zone is matched. */
export function subaddressingChange(mainDomain: string): AgentEmailZoneChange {
  return {
    setting: 'subaddressing',
    description: `Turns on subaddressing for the whole zone: mail to name+anything@${mainDomain}, or to any other address in the zone with a +, then goes where mail to the address without the + goes.`,
  };
}

/** A record in the form the attempt stores and the comparison reads. */
export function toMailRecord(record: MailDnsRecord): AgentEmailMailRecord {
  return {
    type: record.type,
    content: record.content,
    ...(record.priority === undefined ? {} : { priority: record.priority }),
  };
}

/**
 * The listed additions the comparison may find on the main domain: its SPF record. The DKIM key
 * is neither MX nor SPF, so the comparison does not read it.
 */
export function allowedAdditions(
  changes: AgentEmailMainDomainRecord[],
  mainDomain: string
): AgentEmailMailRecord[] {
  return changes.flatMap((change) =>
    change.change === 'add' &&
    change.name === mainDomain &&
    change.content !== null &&
    isSpfRecord({ type: change.type, content: change.content })
      ? [{ type: change.type, content: change.content }]
      : []
  );
}

/**
 * How the main domain's MX and SPF records differ from the attempt's baseline plus the additions
 * the admin allowed. Fewer additions than allowed is no difference: a zone that used Email
 * Routing before gets none.
 */
export function differencesFromBaseline(
  attempt: Pick<AgentEmailSetupAttempt, 'baseline' | 'allowed'>,
  mainDomain: string,
  current: MailDnsRecord[]
): AgentEmailMainDomainRecord[] {
  const added = mailRecordsMissingFrom(current, [...attempt.baseline, ...attempt.allowed]);
  const removed = mailRecordsMissingFrom(attempt.baseline, current);
  const listed = (record: MailDnsRecord, change: 'add' | 'remove') => ({
    type: record.type,
    name: mainDomain,
    content: comparableDnsContent(record),
    change,
  });
  return [
    ...added.map((record) => listed(record, 'add')),
    ...removed.map((record) => listed(record, 'remove')),
  ];
}

export function describeChanges(changes: AgentEmailMainDomainRecord[]): string {
  return changes
    .map((change) =>
      `${change.change === 'add' ? 'added' : 'removed'} ${change.type} ${change.content ?? ''}`.trim()
    )
    .join(', ');
}

/** Binds consent to what a plan lists: any difference in the changes gives another token. */
export async function consentTokenFor(
  plan: Pick<
    AgentEmailSetupPlan,
    'state' | 'domain' | 'mainDomain' | 'mainDomainChanges' | 'zoneChanges'
  >
): Promise<string> {
  const canonical = JSON.stringify({
    state: plan.state,
    domain: plan.domain,
    mainDomain: plan.mainDomain,
    mainDomainChanges: plan.mainDomainChanges
      .map((change) => `${change.change} ${change.type} ${change.name} ${change.content ?? ''}`)
      .sort((a, b) => a.localeCompare(b)),
    zoneChanges: plan.zoneChanges
      .map((change) => change.setting)
      .sort((a, b) => a.localeCompare(b)),
  });
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
