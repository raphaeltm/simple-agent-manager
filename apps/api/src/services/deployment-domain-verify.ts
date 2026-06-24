import * as v from 'valibot';

import type { Env } from '../env';
import { readResponseJson } from '../lib/runtime-validation';
import { fetchWithTimeout, getTimeoutMs } from './fetch-timeout';

/**
 * Custom-domain ownership verification via Cloudflare DNS-over-HTTPS (DoH).
 *
 * For v1, "domain points at us is sufficient" is the ownership proof — there is
 * no TXT challenge. A custom hostname is considered verified when it resolves
 * (CNAME or A) to the SAM-owned route target the user was told to point at, or
 * directly to the node IP that serves the route. SAM never creates the user's
 * DNS record; it only reads it.
 */

/** Default Cloudflare DoH resolver (overridable via env per Constitution XI). */
const DEFAULT_DOH_RESOLVER_URL = 'https://cloudflare-dns.com/dns-query';

/** Default timeout for DoH lookups. */
const DEFAULT_DOH_TIMEOUT_MS = 10_000;

/** DNS record type numbers we care about in DoH answers. */
const DNS_TYPE_A = 1;
const DNS_TYPE_CNAME = 5;

const dohAnswerSchema = v.object({
  Status: v.number(),
  Answer: v.optional(
    v.array(
      v.object({
        name: v.string(),
        type: v.number(),
        data: v.string(),
      }),
    ),
  ),
});

export interface ResolvedHostnameTarget {
  /** Lowercased CNAME targets with any trailing dot stripped. */
  cnames: string[];
  /** A-record IPv4 addresses. */
  a: string[];
}

/** Strip a single trailing dot and lowercase a DNS name for comparison. */
function normalizeDnsName(name: string): string {
  return name.toLowerCase().replace(/\.$/, '');
}

/**
 * Resolve a hostname's CNAME chain and A records via Cloudflare DoH.
 *
 * Queries type=A, which makes the resolver follow the CNAME chain and return
 * both the intermediate CNAME records and the terminal A records in one answer
 * set. Returns empty arrays on NXDOMAIN, resolver errors, or no answers.
 */
export async function resolveHostnameTarget(
  hostname: string,
  env: Env,
): Promise<ResolvedHostnameTarget> {
  const resolverUrl = env.DOH_RESOLVER_URL ?? DEFAULT_DOH_RESOLVER_URL;
  const timeoutMs = getTimeoutMs(env.DOH_TIMEOUT_MS, DEFAULT_DOH_TIMEOUT_MS);
  const url = `${resolverUrl}?name=${encodeURIComponent(hostname)}&type=A`;

  const response = await fetchWithTimeout(
    url,
    { headers: { accept: 'application/dns-json' } },
    timeoutMs,
  );

  if (!response.ok) {
    return { cnames: [], a: [] };
  }

  const data = await readResponseJson(response, dohAnswerSchema, 'cloudflare.doh.resolve');
  const answers = data.Answer ?? [];

  const cnames: string[] = [];
  const a: string[] = [];
  for (const answer of answers) {
    if (answer.type === DNS_TYPE_CNAME) {
      cnames.push(normalizeDnsName(answer.data));
    } else if (answer.type === DNS_TYPE_A) {
      a.push(answer.data);
    }
  }
  return { cnames, a };
}

/**
 * True if a resolved hostname points at the expected SAM route target.
 *
 * Verified when the CNAME chain includes the expected route hostname OR an
 * A record equals the expected node IP (covers users who flatten the CNAME to
 * an A record, which some apex-style DNS providers do).
 */
export function matchesCustomDomainTarget(
  resolved: ResolvedHostnameTarget,
  expectedCnameTarget: string,
  expectedNodeIp: string | undefined,
): boolean {
  const target = normalizeDnsName(expectedCnameTarget);
  if (resolved.cnames.includes(target)) {
    return true;
  }
  if (expectedNodeIp && resolved.a.includes(expectedNodeIp)) {
    return true;
  }
  return false;
}

/**
 * Resolve a custom hostname and check it points at the SAM route target.
 *
 * @param hostname           The user's custom hostname (e.g. app.theircompany.com).
 * @param expectedCnameTarget The SAM-owned route hostname the user was told to CNAME to.
 * @param expectedNodeIp      The node IP serving the route (accepted as an A-record match).
 */
export async function verifyCustomDomainTarget(
  hostname: string,
  expectedCnameTarget: string,
  expectedNodeIp: string | undefined,
  env: Env,
): Promise<boolean> {
  const resolved = await resolveHostnameTarget(hostname, env);
  return matchesCustomDomainTarget(resolved, expectedCnameTarget, expectedNodeIp);
}
