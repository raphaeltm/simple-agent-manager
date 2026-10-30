import { comparableDnsContent } from '@simple-agent-manager/shared';
import * as v from 'valibot';

import type { Env } from '../../env';
import { readResponseJson } from '../../lib/runtime-validation';
import { fetchWithTimeout, getTimeoutMs } from '../fetch-timeout';
import type { EmailReadOptions } from './cloudflare-email-api';

const DEFAULT_DOH_RESOLVER_URL = 'https://cloudflare-dns.com/dns-query';
const DEFAULT_DOH_TIMEOUT_MS = 10_000;
// RFC 7208 section 4.6.4 protocol limit, including nested includes and redirects.
const SPF_LOOKUP_LIMIT = 10;
const answerSchema = v.object({
  Status: v.number(),
  Answer: v.optional(v.array(v.object({ type: v.number(), data: v.string() })), []),
});

export async function readPublicSpf(
  env: Env,
  domain: string,
  options: EmailReadOptions = {}
): Promise<string> {
  const url = new URL(env.DOH_RESOLVER_URL ?? DEFAULT_DOH_RESOLVER_URL);
  url.searchParams.set('name', domain);
  url.searchParams.set('type', 'TXT');
  const response = await fetchWithTimeout(
    url.toString(),
    { headers: { accept: 'application/dns-json' } },
    options.timeoutMs ?? getTimeoutMs(env.DOH_TIMEOUT_MS, DEFAULT_DOH_TIMEOUT_MS),
    options.callerSignal
  );
  if (!response.ok) throw new Error('Could not verify the SPF lookup budget. Try again later.');
  const data = await readResponseJson(response, answerSchema, 'agent_email.spf_dns');
  const records = data.Answer.filter((record) => record.type === 16)
    .map((record) => comparableDnsContent({ type: 'TXT', content: record.data }))
    .filter((content) => /^v=spf1(?:\s|$)/i.test(content));
  if (data.Status !== 0 || records.length !== 1 || !records[0])
    throw new Error(`Cannot verify the SPF policy of ${domain}.`);
  return records[0];
}

/** Conservative upper bound: reject macros/unknown terms rather than change their meaning. */
export async function verifySpfLookupBudget(
  policy: string,
  lookup: (domain: string) => Promise<string>
): Promise<void> {
  let count = 0;
  async function visit(content: string, ancestors: Set<string>): Promise<void> {
    const terms = content.trim().split(/\s+/);
    if (terms.shift()?.toLowerCase() !== 'v=spf1') throw new Error('Invalid SPF version.');
    const children: { domain: string; ancestors: Set<string> }[] = [];
    for (const term of terms) {
      const mechanism = term.replace(/^[+?~-]/, '').toLowerCase();
      if (/^(?:all|ip[46]:[^%]+)$/.test(mechanism)) continue;
      if (mechanism.startsWith('exp=')) continue; // Not evaluated for SPF authorization.
      const nested = /^(?:include:|redirect=)([a-z0-9_.-]+)$/.exec(mechanism);
      if (!nested)
        throw new Error(
          'This SPF policy uses mechanisms that automatic setup cannot safely verify.'
        );
      if (++count > SPF_LOOKUP_LIMIT)
        throw new Error('The proposed SPF policy exceeds the 10 DNS lookup limit.');
      const domain = nested[1];
      if (!domain || ancestors.has(domain))
        throw new Error('The SPF policy contains an include or redirect loop.');
      children.push({ domain, ancestors: new Set([...ancestors, domain]) });
    }
    const policies = await Promise.all(children.map(({ domain }) => lookup(domain)));
    await Promise.all(
      children.map((child, index) => visit(policies[index] ?? '', child.ancestors))
    );
  }
  await visit(policy, new Set());
}
