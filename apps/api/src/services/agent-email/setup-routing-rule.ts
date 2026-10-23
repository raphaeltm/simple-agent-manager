/**
 * The one Email Routing rule agent email needs: the literal address `agent@agents.<BASE_DOMAIN>`
 * routed to this Worker. Subaddressing then routes every `agent+<key>@` address through it.
 *
 * Managed through the REST API. Do not also add a top-level `addresses` field to
 * apps/api/wrangler.toml: Wrangler reconciles that field on every deploy and would take over, or
 * remove, this rule.
 */
import type { Env } from '../../env';
import {
  createRoutingRule,
  listRoutingRules,
  type RoutingRuleInput,
  type RoutingRuleView,
  updateRoutingRule,
} from './cloudflare-email-api';
import { AgentEmailSetupRefusedError } from './setup-errors';

/** The rule's display name only: the rule is found by the address it matches. */
export const AGENT_EMAIL_RULE_NAME = 'SAM agent email';
/** Cloudflare's `per_page` maximum for listing Email Routing rules. */
const RULES_PAGE_SIZE = 50;
/** Cloudflare's limit on Email Routing rules per domain. */
const CLOUDFLARE_ROUTING_RULE_LIMIT = 200;
/** Enough pages for a zone at the limit, plus one that shows the list has ended. */
const MAX_RULE_PAGES = Math.ceil(CLOUDFLARE_ROUTING_RULE_LIMIT / RULES_PAGE_SIZE) + 1;

function normalizeAddress(address: string): string {
  return address.toLowerCase().replace(/\.$/, '');
}

function ruleMatchesAddress(rule: RoutingRuleView, address: string): boolean {
  return (rule.matchers ?? []).some(
    (matcher) =>
      matcher.type === 'literal' &&
      matcher.field === 'to' &&
      normalizeAddress(matcher.value ?? '') === address
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
    `This zone lists more than ${MAX_RULE_PAGES * RULES_PAGE_SIZE} Email Routing rules, past Cloudflare's limit of ${CLOUDFLARE_ROUTING_RULE_LIMIT}, so SAM cannot tell whether the agent email rule exists.`
  );
}

/**
 * Points the rule for `address` at `workerName`, creating it if there is none. `beforeWrite` runs
 * after the rules are listed and right before the one write, so it can stop a run whose listing
 * stalled.
 */
export async function ensureRoutingRule(
  env: Env,
  address: string,
  workerName: string,
  beforeWrite: () => Promise<void>
): Promise<void> {
  const desired: RoutingRuleInput = {
    name: AGENT_EMAIL_RULE_NAME,
    enabled: true,
    matchers: [{ type: 'literal', field: 'to', value: address }],
    actions: [{ type: 'worker', value: [workerName] }],
  };
  const existing = await findRule(env, address);
  if (existing && ruleRoutesToWorker(existing, workerName)) return;
  await beforeWrite();
  if (existing) await updateRoutingRule(env, existing.id, desired);
  else await createRoutingRule(env, desired);
}
