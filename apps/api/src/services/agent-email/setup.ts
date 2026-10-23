/**
 * Agent email admin setup (preview): the step that turns agent email on once the deploy has
 * prepared it (`scripts/deploy/configure-agent-email.ts`: Email Sending and the send binding).
 *
 * It turns Email Routing on for `agents.<BASE_DOMAIN>`, turns on subaddressing, and points one
 * literal rule `agent@agents.<BASE_DOMAIN>` at this Worker. The first time a zone uses Email
 * Routing, Cloudflare also adds its SPF record and a DKIM key to the root domain, whichever
 * subdomain is named (seen on staging, deploy run 39866499256; Cloudflare's domain configuration
 * docs: "Email Routing DNS records are configured on the root domain"). So:
 *
 * - in a zone that already uses Email Routing, setup changes nothing on the root domain;
 * - in a zone new to it whose root domain has no MX or SPF records, the admin must allow exactly
 *   those two records first (`needs_consent`);
 * - in a zone new to it whose root domain has its own mail records, setup refuses: what
 *   Cloudflare does to an existing SPF record is untested, and a second one breaks SPF.
 *
 * A zone where routing is on for a subdomain alone reads `enabled: true` (staging on 2026-10-23:
 * status `misconfigured`, because the root domain has no MX), so a re-run after `pending` plans
 * `ready` and asks for no consent again.
 *
 * After turning routing on, the root domain may have gained only the disclosed SPF record and
 * lost nothing; otherwise setup stops and agent email stays off. Cloudflare has already made that
 * change by then, so the error lists the records, and running the setup again turns agent email
 * on with them as they are. Re-running is safe: every step checks first. Two admins racing at
 * worst create a duplicate `agent@` rule pointing at this Worker, which changes no routing.
 */
import {
  AGENT_EMAIL_LOCAL_PART,
  type AgentEmailMainDomainRecord,
  type AgentEmailSetupPlan,
  describeMailRecord,
  isCloudflareRoutingMx,
  isSpfRecord,
  type MailDnsRecord,
  mailRecordsMissingFrom,
} from '@simple-agent-manager/shared';

import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { agentEmailDomain } from './address';
import {
  createRoutingRule,
  type DnsRecordView,
  enableSubaddressing,
  enableSubdomainRouting,
  getRoutingSettings,
  getZoneName,
  listDnsRecords,
  listRoutingRules,
  listSendingSubdomains,
  type RoutingRuleInput,
  type RoutingRuleView,
  updateRoutingRule,
} from './cloudflare-email-api';
import { hasAgentEmailBinding, isAgentEmailOn, recordAgentEmailSetup } from './setup-state';

/** The SPF record Cloudflare adds to the root domain the first time a zone uses Email Routing. */
export const CLOUDFLARE_ROUTING_SPF = 'v=spf1 include:_spf.mx.cloudflare.net ~all';
/** The DKIM selector Cloudflare adds under the root domain at the same time. */
export const CLOUDFLARE_ROUTING_DKIM_SELECTOR = 'cf2024-1._domainkey';
/** The rule's display name only: the rule is found by the address it matches. */
export const AGENT_EMAIL_RULE_NAME = 'SAM agent email';
/** Cloudflare's `per_page` maximum for listing Email Routing rules. */
const RULES_PAGE_SIZE = 50;
/** Cloudflare's limit on Email Routing rules per domain. */
const CLOUDFLARE_ROUTING_RULE_LIMIT = 200;
/** Enough pages for a zone at the limit, plus one that shows the list has ended. */
const MAX_RULE_PAGES = Math.ceil(CLOUDFLARE_ROUTING_RULE_LIMIT / RULES_PAGE_SIZE) + 1;

/** Setup cannot run in the plan's current state; the message says why. */
export class AgentEmailSetupRefusedError extends Error {
  constructor(readonly plan: AgentEmailSetupPlan) {
    super(plan.reason ?? `Agent email setup cannot run while it is ${plan.state}`);
    this.name = 'AgentEmailSetupRefusedError';
  }
}

/** Turning routing on changed the main domain's mail records beyond what was disclosed. */
export class AgentEmailMainDomainChangedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentEmailMainDomainChangedError';
  }
}

/** What the plan read from Cloudflare, so the run does not read it again. */
interface SetupFacts {
  subdomainRouting: boolean;
  /** The main domain's MX and SPF records, when the plan read them. */
  mainDomainMail: DnsRecordView[] | null;
  subaddressing: boolean | null;
}

interface Inspection {
  plan: AgentEmailSetupPlan;
  facts: SetupFacts | null;
}

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/\.$/, '');
}

function plan(
  state: AgentEmailSetupPlan['state'],
  fields: Partial<Omit<AgentEmailSetupPlan, 'state'>> = {}
): AgentEmailSetupPlan {
  return {
    state,
    domain: fields.domain ?? null,
    mainDomain: fields.mainDomain ?? null,
    mainDomainChanges: fields.mainDomainChanges ?? [],
    reason: fields.reason ?? null,
  };
}

/** The records that decide where a name's mail goes and who may send as it: MX and SPF. */
async function listMailRecords(env: Env, name: string): Promise<DnsRecordView[]> {
  const [mx, txt] = await Promise.all([
    listDnsRecords(env, 'MX', name),
    listDnsRecords(env, 'TXT', name),
  ]);
  return [...mx, ...txt.filter(isSpfRecord)];
}

async function subdomainRoutingOn(env: Env, domain: string): Promise<boolean> {
  return (await listDnsRecords(env, 'MX', domain)).some(isCloudflareRoutingMx);
}

function routingRecordsFor(mainDomain: string): AgentEmailMainDomainRecord[] {
  return [
    { type: 'TXT', name: mainDomain, content: CLOUDFLARE_ROUTING_SPF },
    // Cloudflare generates the key, so its content is not known in advance.
    { type: 'TXT', name: `${CLOUDFLARE_ROUTING_DKIM_SELECTOR}.${mainDomain}`, content: null },
  ];
}

/** What the setup would do now. Reads Cloudflare only when the deploy prepared agent email. */
export async function planAgentEmailSetup(env: Env): Promise<AgentEmailSetupPlan> {
  return (await inspect(env)).plan;
}

async function inspect(env: Env): Promise<Inspection> {
  if (!hasAgentEmailBinding(env)) {
    return {
      plan: plan('unavailable', {
        reason:
          'This deployment has not prepared agent email. A staging deploy started with the agent_email input prepares it, once the deploy token has the Email Routing and Email Sending permissions.',
      }),
      facts: null,
    };
  }
  const domain = agentEmailDomain(env.BASE_DOMAIN);
  if (!env.AGENT_EMAIL_WORKER_NAME?.trim()) {
    return {
      plan: plan('unavailable', {
        domain,
        reason: 'Deploy again: this deployment predates the agent email setup.',
      }),
      facts: null,
    };
  }
  if (await isAgentEmailOn(env)) return { plan: plan('on', { domain }), facts: null };

  const mainDomain = normalizeName(await getZoneName(env));
  const sending = (await listSendingSubdomains(env)).find(
    (subdomain) => normalizeName(subdomain.name) === domain
  );
  if (!sending) {
    return {
      plan: plan('unavailable', {
        domain,
        mainDomain,
        reason: `Email Sending is not set up for ${domain}. Deploy again with the agent_email input.`,
      }),
      facts: null,
    };
  }
  const verified = sending.enabled === true;
  const ready = (facts: SetupFacts): Inspection => ({
    plan: verified ? plan('ready', { domain, mainDomain }) : verifying(domain, mainDomain),
    facts,
  });

  if (await subdomainRoutingOn(env, domain)) {
    return ready({ subdomainRouting: true, mainDomainMail: null, subaddressing: null });
  }
  const settings = await getRoutingSettings(env);
  const subaddressing = settings.support_subaddress === true;
  if (settings.enabled === true) {
    return ready({ subdomainRouting: false, mainDomainMail: null, subaddressing });
  }

  const mainDomainMail = await listMailRecords(env, mainDomain);
  const facts: SetupFacts = { subdomainRouting: false, mainDomainMail, subaddressing };
  if (mainDomainMail.length > 0) {
    return {
      plan: plan('refused', {
        domain,
        mainDomain,
        reason: `${mainDomain} has its own mail records (${mainDomainMail
          .map(describeMailRecord)
          .join(
            ', '
          )}). Turning Email Routing on would add Cloudflare's SPF record beside them, and SAM cannot do that safely yet.`,
      }),
      facts,
    };
  }
  if (!verified) return { plan: verifying(domain, mainDomain), facts };
  return {
    plan: plan('needs_consent', {
      domain,
      mainDomain,
      mainDomainChanges: routingRecordsFor(mainDomain),
      reason: `${mainDomain} has never used Email Routing, so turning it on lets Cloudflare add an SPF record and a DKIM key to ${mainDomain}.`,
    }),
    facts,
  };
}

function verifying(domain: string, mainDomain: string): AgentEmailSetupPlan {
  return plan('verifying', {
    domain,
    mainDomain,
    reason: `Cloudflare is still verifying the sending records for ${domain}, usually 5 to 15 minutes after the deploy created them. Try again then.`,
  });
}

function ruleMatchesAddress(rule: RoutingRuleView, address: string): boolean {
  return (rule.matchers ?? []).some(
    (matcher) =>
      matcher.type === 'literal' &&
      matcher.field === 'to' &&
      normalizeName(matcher.value ?? '') === address
  );
}

function ruleRoutesToWorker(rule: RoutingRuleView, workerName: string): boolean {
  return (
    rule.enabled === true &&
    rule.actions?.length === 1 &&
    rule.actions[0]?.type === 'worker' &&
    rule.actions[0]?.value?.length === 1 &&
    rule.actions[0]?.value?.[0] === workerName
  );
}

async function findRule(env: Env, address: string): Promise<RoutingRuleView | null> {
  for (let page = 1; page <= MAX_RULE_PAGES; page += 1) {
    const rules = await listRoutingRules(env, page, RULES_PAGE_SIZE);
    const match = rules.find((rule) => ruleMatchesAddress(rule, address));
    if (match) return match;
    if (rules.length < RULES_PAGE_SIZE) return null;
  }
  throw new AgentEmailSetupRefusedError(
    plan('refused', {
      reason: `This zone lists more than ${MAX_RULE_PAGES * RULES_PAGE_SIZE} Email Routing rules, past Cloudflare's limit of ${CLOUDFLARE_ROUTING_RULE_LIMIT}, so SAM cannot tell whether the agent email rule exists.`,
    })
  );
}

// Managed through this REST call. Do not also add a top-level `addresses` field to
// apps/api/wrangler.toml: Wrangler reconciles that field on every deploy and would take over,
// or remove, this rule.
async function ensureRoutingRule(env: Env, address: string, workerName: string): Promise<void> {
  const desired: RoutingRuleInput = {
    name: AGENT_EMAIL_RULE_NAME,
    enabled: true,
    matchers: [{ type: 'literal', field: 'to', value: address }],
    actions: [{ type: 'worker', value: [workerName] }],
  };
  const existing = await findRule(env, address);
  if (existing && ruleRoutesToWorker(existing, workerName)) return;
  if (existing) await updateRoutingRule(env, existing.id, desired);
  else await createRoutingRule(env, desired);
}

/**
 * After routing came on, the root domain may have gained the disclosed SPF record and nothing
 * else, and lost nothing. Gaining less than disclosed is fine: a zone that used Email Routing
 * before gets no new records.
 */
function assertMainDomainAsDisclosed(
  mainDomain: string,
  before: MailDnsRecord[],
  after: MailDnsRecord[],
  disclosed: AgentEmailMainDomainRecord[]
): void {
  const allowed: MailDnsRecord[] = [
    ...before,
    ...disclosed.flatMap((record) =>
      record.name === mainDomain &&
      record.content !== null &&
      isSpfRecord({ type: record.type, content: record.content })
        ? [{ type: record.type, name: record.name, content: record.content }]
        : []
    ),
  ];
  const removed = mailRecordsMissingFrom(before, after);
  const added = mailRecordsMissingFrom(after, allowed);
  if (removed.length === 0 && added.length === 0) return;
  log.error('agent_email.setup_main_domain_changed', {
    mainDomain,
    added: added.map(describeMailRecord),
    removed: removed.map(describeMailRecord),
  });
  const changes = [
    ...added.map((record) => `added ${describeMailRecord(record)}`),
    ...removed.map((record) => `removed ${describeMailRecord(record)}`),
  ];
  throw new AgentEmailMainDomainChangedError(
    `Turning Email Routing on changed the mail records of ${mainDomain} in a way the setup did not show: ${changes.join(
      ', '
    )}. Agent email is still off. Check these records; running the setup again turns agent email on with them as they are.`
  );
}

/**
 * Runs the setup. Refuses (AgentEmailSetupRefusedError) unless the plan is `ready`, or
 * `needs_consent` with `allowMainDomainChanges`. Returns `on`, or `pending` when routing was
 * turned on but its records are not visible yet.
 */
export async function runAgentEmailSetup(
  env: Env,
  options: { allowMainDomainChanges: boolean; userId: string }
): Promise<AgentEmailSetupPlan> {
  const { plan: current, facts } = await inspect(env);
  if (current.state === 'on') return current;
  if (current.state === 'needs_consent' && !options.allowMainDomainChanges) {
    throw new AgentEmailSetupRefusedError({
      ...current,
      reason: `Allow the changes to ${current.mainDomain} to turn agent email on.`,
    });
  }
  const { domain, mainDomain } = current;
  const workerName = env.AGENT_EMAIL_WORKER_NAME?.trim();
  if (
    (current.state !== 'ready' && current.state !== 'needs_consent') ||
    !facts ||
    !domain ||
    !mainDomain ||
    !workerName
  ) {
    throw new AgentEmailSetupRefusedError(current);
  }

  if (!facts.subdomainRouting) {
    const before = facts.mainDomainMail ?? (await listMailRecords(env, mainDomain));
    await enableSubdomainRouting(env, domain);
    assertMainDomainAsDisclosed(
      mainDomain,
      before,
      await listMailRecords(env, mainDomain),
      current.mainDomainChanges
    );
    if (!(await subdomainRoutingOn(env, domain))) {
      return plan('pending', {
        domain,
        mainDomain,
        mainDomainChanges: current.mainDomainChanges,
        reason: `Email Routing is turning on for ${domain}, but its records are not visible yet. Run the setup again in a minute.`,
      });
    }
  }
  const subaddressing =
    facts.subaddressing ?? (await getRoutingSettings(env)).support_subaddress === true;
  if (!subaddressing) await enableSubaddressing(env);
  await ensureRoutingRule(env, `${AGENT_EMAIL_LOCAL_PART}@${domain}`, workerName);

  await recordAgentEmailSetup(
    env,
    { domain, enabledAt: new Date().toISOString(), mainDomainChanges: current.mainDomainChanges },
    options.userId
  );
  log.info('agent_email.setup_completed', {
    domain,
    mainDomain,
    mainDomainChanges: current.mainDomainChanges.length,
    userId: options.userId,
  });
  return plan('on', { domain, mainDomain, mainDomainChanges: current.mainDomainChanges });
}
