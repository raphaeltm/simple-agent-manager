/**
 * Agent email admin setup (preview): the step that turns agent email on once the deploy has
 * prepared it (`scripts/deploy/configure-agent-email.ts`: Email Sending and the send binding).
 *
 * It turns Email Routing on for `agents.<BASE_DOMAIN>`, turns on subaddressing, and points one
 * literal rule `agent@agents.<BASE_DOMAIN>` at this Worker (`./setup-routing-rule.ts`). Two of
 * those reach past the subdomain, so the plan lists them and the admin must allow them first
 * (`needs_consent`, bound to the plan by `consentToken`):
 *
 * - The first time a zone uses Email Routing, Cloudflare adds its SPF record and a DKIM key to
 *   the root domain, whichever subdomain is named (seen on staging, deploy run 39866499256;
 *   Cloudflare's domain configuration docs: "Email Routing DNS records are configured on the
 *   root domain"). A zone new to Email Routing whose root domain has its own MX or SPF records is
 *   refused: what Cloudflare does to an existing SPF record is untested, and a second one breaks
 *   SPF.
 * - Subaddressing is a zone setting, so turning it on changes how every address in the zone is
 *   matched.
 *
 * A zone where routing is on for a subdomain alone reads `enabled: true` (staging on 2026-10-23:
 * status `misconfigured`, because the root domain has no MX).
 *
 * Before changing anything, a run stores the root domain's MX and SPF records as its baseline
 * (`./setup-state.ts`). After turning routing on, the root domain may differ from that baseline
 * only by the SPF record the admin allowed. Every later run checks against the same baseline, so
 * neither a concurrent run nor a retry after `pending` or a failed check can skip the check
 * because routing is already on. A failed check leaves agent email off; the plan then lists the
 * differences (`changed`), and the admin fixes the records or allows them as they are. Two runs
 * at once at worst create a duplicate `agent@` rule pointing at this Worker, which changes no
 * routing.
 */
import {
  AGENT_EMAIL_LOCAL_PART,
  type AgentEmailMainDomainRecord,
  type AgentEmailSetupPlan,
  type AgentEmailZoneChange,
  describeMailRecord,
  isCloudflareRoutingMx,
  isSpfRecord,
} from '@simple-agent-manager/shared';

import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { DEFAULT_CF_API_TIMEOUT_MS } from '../dns-core';
import { getTimeoutMs } from '../fetch-timeout';
import { agentEmailDomain } from './address';
import {
  type DnsRecordView,
  enableSubaddressing,
  enableSubdomainRouting,
  getRoutingSettings,
  getZoneName,
  listDnsRecords,
  listSendingSubdomains,
} from './cloudflare-email-api';
import {
  allowedAdditions,
  consentTokenFor,
  describeChanges,
  differencesFromBaseline,
  firstRoutingRecords,
  subaddressingChange,
  toMailRecord,
} from './setup-changes';
import { AgentEmailMainDomainChangedError, AgentEmailSetupRefusedError } from './setup-errors';
import { ensureRoutingRule } from './setup-routing-rule';
import {
  type AgentEmailSetupAttempt,
  claimSetupAttempt,
  completeAgentEmailSetup,
  hasAgentEmailBinding,
  isAgentEmailOn,
  readSetupAttempt,
  replaceSetupAttempt,
  type StoredSetupAttempt,
} from './setup-state';

/** What the plan read, so the run acts on the same facts the admin was shown. */
interface SetupFacts {
  mainDomain: string;
  subdomainRouting: boolean;
  /** The main domain's MX and SPF records, read before this run changes anything. */
  mainDomainMail: DnsRecordView[];
  subaddressing: boolean;
  attempt: StoredSetupAttempt | null;
}

interface Inspection {
  plan: AgentEmailSetupPlan;
  facts: SetupFacts | null;
}

type PlanFields = Partial<Omit<AgentEmailSetupPlan, 'state' | 'consentToken'>>;

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/\.$/, '');
}

function plan(state: AgentEmailSetupPlan['state'], fields: PlanFields = {}): AgentEmailSetupPlan {
  return {
    state,
    domain: fields.domain ?? null,
    mainDomain: fields.mainDomain ?? null,
    mainDomainChanges: fields.mainDomainChanges ?? [],
    zoneChanges: fields.zoneChanges ?? [],
    consentToken: null,
    reason: fields.reason ?? null,
  };
}

async function withConsent(planned: AgentEmailSetupPlan): Promise<AgentEmailSetupPlan> {
  return { ...planned, consentToken: await consentTokenFor(planned) };
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

/** What the setup would do now. Reads Cloudflare only when the deploy prepared agent email. */
export async function planAgentEmailSetup(env: Env): Promise<AgentEmailSetupPlan> {
  return (await inspect(env)).plan;
}

function unavailable(reason: string, fields: PlanFields = {}): Inspection {
  return { plan: plan('unavailable', { ...fields, reason }), facts: null };
}

async function inspect(env: Env): Promise<Inspection> {
  if (!hasAgentEmailBinding(env)) {
    return unavailable(
      'This deployment has not prepared agent email. A staging deploy started with the agent_email input prepares it, once the deploy token has the Email Routing and Email Sending permissions.'
    );
  }
  const domain = agentEmailDomain(env.BASE_DOMAIN);
  if (!env.AGENT_EMAIL_WORKER_NAME?.trim()) {
    return unavailable('Deploy again: this deployment predates the agent email setup.', {
      domain,
    });
  }
  if (await isAgentEmailOn(env)) return { plan: plan('on', { domain }), facts: null };

  const mainDomain = normalizeName(await getZoneName(env));
  const [sendingSubdomains, subdomainMx, settings, mainDomainMail, attempt] = await Promise.all([
    listSendingSubdomains(env),
    listDnsRecords(env, 'MX', domain),
    getRoutingSettings(env),
    listMailRecords(env, mainDomain),
    readSetupAttempt(env, domain),
  ]);
  const sending = sendingSubdomains.find((subdomain) => normalizeName(subdomain.name) === domain);
  if (!sending) {
    return unavailable(
      `Email Sending is not set up for ${domain}. Deploy again with the agent_email input.`,
      { domain, mainDomain }
    );
  }
  const facts: SetupFacts = {
    mainDomain,
    subdomainRouting: subdomainMx.some(isCloudflareRoutingMx),
    mainDomainMail,
    subaddressing: settings.support_subaddress === true,
    attempt,
  };
  const base = { domain, mainDomain };
  const zoneUsesRouting = facts.subdomainRouting || settings.enabled === true;

  if (!attempt && !zoneUsesRouting && mainDomainMail.length > 0) {
    return {
      plan: plan('refused', {
        ...base,
        reason: `${mainDomain} has its own mail records (${mainDomainMail
          .map(describeMailRecord)
          .join(
            ', '
          )}). Turning Email Routing on would add Cloudflare's SPF record beside them, and SAM cannot do that safely yet.`,
      }),
      facts,
    };
  }
  if (sending.enabled !== true) {
    return {
      plan: plan('verifying', {
        ...base,
        reason: `Cloudflare is still verifying the sending records for ${domain}, usually 5 to 15 minutes after the deploy created them. Try again then.`,
      }),
      facts,
    };
  }

  // Still off: listed either way, so the admin sees it, but consent given for an earlier run
  // that stopped before making it still holds.
  const zoneChanges = facts.subaddressing
    ? []
    : [
        subaddressingChange(
          mainDomain,
          attempt?.attempt.zoneChanges.includes('subaddressing') ?? false
        ),
      ];
  if (attempt) {
    const differences = differencesFromBaseline(attempt.attempt, mainDomain, mainDomainMail);
    if (differences.length > 0) {
      return {
        plan: await withConsent(
          plan('changed', {
            ...base,
            mainDomainChanges: differences,
            zoneChanges,
            reason: `An earlier setup run turned Email Routing on, and the mail records of ${mainDomain} now differ from what it showed: ${describeChanges(differences)}. Agent email stays off. Fix them in Cloudflare and check again, or allow them as they are.`,
          })
        ),
        facts,
      };
    }
    // The records Cloudflare adds were allowed when that run started.
    return { plan: await consentPlan(base, [], zoneChanges), facts };
  }
  return {
    plan: await consentPlan(
      base,
      zoneUsesRouting ? [] : firstRoutingRecords(mainDomain),
      zoneChanges
    ),
    facts,
  };
}

async function consentPlan(
  base: { domain: string; mainDomain: string },
  mainDomainChanges: AgentEmailMainDomainRecord[],
  zoneChanges: AgentEmailZoneChange[]
): Promise<AgentEmailSetupPlan> {
  const newZoneChanges = zoneChanges.filter((change) => !change.allowed);
  if (mainDomainChanges.length === 0 && newZoneChanges.length === 0) {
    return plan('ready', { ...base, zoneChanges });
  }
  const reasons = [
    ...(mainDomainChanges.length > 0
      ? [
          `${base.mainDomain} has never used Email Routing, so turning it on lets Cloudflare add an SPF record and a DKIM key to ${base.mainDomain}.`,
        ]
      : []),
    ...(newZoneChanges.length > 0 ? ['Agent email also needs subaddressing on for the zone.'] : []),
  ];
  return withConsent(
    plan('needs_consent', { ...base, mainDomainChanges, zoneChanges, reason: reasons.join(' ') })
  );
}

/**
 * How long a run holds the setup lease: longer than the Cloudflare calls a run waits for one
 * after another (about ten), each bounded by the Cloudflare API timeout. Every exit releases it,
 * so the lease only lapses on its own if the Worker died mid-run.
 */
function setupLeaseMs(env: Env): number {
  return 20 * getTimeoutMs(env.CF_API_TIMEOUT_MS, DEFAULT_CF_API_TIMEOUT_MS);
}

function leaseHeld(attempt: AgentEmailSetupAttempt, now: number): boolean {
  return attempt.owner !== null && Date.parse(attempt.leaseUntil ?? '') > now;
}

/**
 * Stores the attempt and takes its lease before anything changes Cloudflare. A new attempt keeps
 * the baseline this run read; one left by an earlier run keeps its own, unless the admin allowed
 * the records as they are now (`changed`). Refuses while another run holds the lease.
 */
async function claimAttempt(
  env: Env,
  current: AgentEmailSetupPlan,
  facts: SetupFacts,
  userId: string
): Promise<StoredSetupAttempt> {
  const now = Date.now();
  const lease = {
    owner: crypto.randomUUID(),
    leaseUntil: new Date(now + setupLeaseMs(env)).toISOString(),
  };
  const acceptedZoneChanges = current.zoneChanges.map((change) => change.setting);
  if (!facts.attempt) {
    const attempt: AgentEmailSetupAttempt = {
      domain: current.domain ?? '',
      startedAt: new Date(now).toISOString(),
      startedBy: userId,
      baseline: facts.mainDomainMail.map(toMailRecord),
      allowed: allowedAdditions(current.mainDomainChanges, facts.mainDomain),
      zoneChanges: acceptedZoneChanges,
      ...lease,
    };
    const stored = await claimSetupAttempt(env, attempt);
    if (stored.attempt.owner !== lease.owner) {
      throw new AgentEmailSetupRefusedError(
        'Another agent email setup run started at the same time. Check again.'
      );
    }
    return stored;
  }
  const previous = facts.attempt.attempt;
  if (leaseHeld(previous, now)) {
    throw new AgentEmailSetupRefusedError(
      'Another agent email setup run is in progress. Check again in a few minutes.'
    );
  }
  const next: AgentEmailSetupAttempt = {
    ...previous,
    ...(current.state === 'changed'
      ? { baseline: facts.mainDomainMail.map(toMailRecord), allowed: [] }
      : {}),
    zoneChanges: [...new Set([...previous.zoneChanges, ...acceptedZoneChanges])],
    ...lease,
  };
  if (!(await replaceSetupAttempt(env, facts.attempt, next))) {
    throw new AgentEmailSetupRefusedError(
      'Another agent email setup run changed the setup at the same time. Check again.'
    );
  }
  return { attempt: next, stored: JSON.stringify(next) };
}

/** Gives the lease back, keeping the baseline. A run that lost the lease has nothing to give. */
async function releaseAttempt(env: Env, owned: StoredSetupAttempt): Promise<void> {
  try {
    await replaceSetupAttempt(env, owned, { ...owned.attempt, owner: null, leaseUntil: null });
  } catch (error) {
    log.error('agent_email.setup_lease_release_failed', {
      domain: owned.attempt.domain,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Runs the setup. Refuses (AgentEmailSetupRefusedError) unless the plan is `ready`, or lists
 * changes and `consentToken` is that plan's token. Returns `on`, or `pending` when routing was
 * turned on but its records are not visible yet.
 */
export async function runAgentEmailSetup(
  env: Env,
  options: { consentToken: string | null; userId: string }
): Promise<AgentEmailSetupPlan> {
  const { plan: current, facts } = await inspect(env);
  if (current.state === 'on') return current;
  const workerName = env.AGENT_EMAIL_WORKER_NAME?.trim();
  const runnable =
    current.state === 'ready' || current.state === 'needs_consent' || current.state === 'changed';
  if (!runnable || !facts || !current.domain || !workerName) {
    throw new AgentEmailSetupRefusedError(
      current.reason ?? `Agent email setup cannot run while it is ${current.state}`
    );
  }
  if (current.consentToken !== null && options.consentToken !== current.consentToken) {
    throw new AgentEmailSetupRefusedError(
      options.consentToken
        ? 'What turning agent email on would change is different from what you allowed. Review it and allow it again.'
        : `Allow the changes to ${facts.mainDomain} to turn agent email on.`
    );
  }
  const owned = await claimAttempt(env, current, facts, options.userId);
  let completed = false;
  try {
    const result = await setUpWhileHoldingLease(
      env,
      current,
      facts,
      owned,
      workerName,
      options.userId
    );
    completed = result.state === 'on';
    return result;
  } finally {
    if (!completed) await releaseAttempt(env, owned);
  }
}

async function setUpWhileHoldingLease(
  env: Env,
  current: AgentEmailSetupPlan,
  facts: SetupFacts,
  owned: StoredSetupAttempt,
  workerName: string,
  userId: string
): Promise<AgentEmailSetupPlan> {
  const domain = current.domain ?? '';
  const { mainDomain } = facts;
  const { attempt } = owned;

  if (!facts.subdomainRouting) await enableSubdomainRouting(env, domain);
  const differences = differencesFromBaseline(
    attempt,
    mainDomain,
    await listMailRecords(env, mainDomain)
  );
  if (differences.length > 0) {
    log.error('agent_email.setup_main_domain_changed', {
      mainDomain,
      differences: describeChanges(differences),
    });
    throw new AgentEmailMainDomainChangedError(
      `Turning Email Routing on changed the mail records of ${mainDomain} in a way the setup did not show: ${describeChanges(differences)}. Agent email is still off. Fix them in Cloudflare and check again, or allow them as they are.`
    );
  }
  if (!facts.subdomainRouting && !(await subdomainRoutingOn(env, domain))) {
    return plan('pending', {
      domain,
      mainDomain,
      reason: `Email Routing is turning on for ${domain}, but its records are not visible yet. Run the setup again in a minute.`,
    });
  }
  // Allowed by this run's consent or an earlier one: the plan listed it otherwise.
  if (!facts.subaddressing) await enableSubaddressing(env);
  await ensureRoutingRule(env, `${AGENT_EMAIL_LOCAL_PART}@${domain}`, workerName);

  const finished = await completeAgentEmailSetup(
    env,
    {
      domain,
      enabledAt: new Date().toISOString(),
      mainDomainChanges: current.mainDomainChanges,
      zoneChanges: attempt.zoneChanges,
    },
    userId,
    owned
  );
  if (!finished) {
    throw new AgentEmailSetupRefusedError(
      'Another agent email setup run took over before this one finished. Check again.'
    );
  }
  log.info('agent_email.setup_completed', {
    domain,
    mainDomain,
    mainDomainChanges: current.mainDomainChanges.length,
    zoneChanges: attempt.zoneChanges,
    userId,
  });
  return plan('on', {
    domain,
    mainDomain,
    mainDomainChanges: current.mainDomainChanges,
    zoneChanges: current.zoneChanges,
  });
}
