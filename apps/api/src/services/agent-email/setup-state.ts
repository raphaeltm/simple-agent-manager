/**
 * Agent email's on-switch and the admin setup's in-progress record (preview).
 *
 * The deploy only prepares agent email: Email Sending for `agents.<BASE_DOMAIN>` and the
 * `AGENT_EMAIL` send binding. A superadmin turns it on with the admin setup (`./setup.ts`),
 * which writes the record kept here. Agent email is on only when the binding exists and that
 * record names the current agent email domain, so a deployment whose binding ships before
 * anyone ran the setup refuses inbound mail and replies.
 *
 * Every check reads the record from D1 rather than a per-isolate cache, so an unreadable record
 * or a D1 outage turns agent email off at once. The readers are not per-request paths: inbound
 * mail, replies, email trigger creation, the recovery sweep, the loopback test, and the public
 * config endpoint, which is HTTP-cached.
 *
 * While a setup runs, and after one stops part-way, the attempt record holds the main domain's
 * MX and SPF records as they were before the setup first changed anything, and the changes the
 * admin allowed. Every later run checks the main domain against that baseline, so no run can
 * skip the check because an earlier one already turned routing on. The record also carries the
 * running setup's lease: one run at a time changes Cloudflare, and only the run holding the
 * lease can turn agent email on and drop the record.
 */
import type { AgentEmailConfigResponse } from '@simple-agent-manager/shared';
import * as v from 'valibot';

import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { readSetting } from '../platform-config-store';
import { agentEmailDomain } from './address';
import { type AgentEmailSender, agentEmailSenderFor } from './provider';

/** `platform_settings` key of the on-switch. Not an admin setting: only the setup writes it. */
export const AGENT_EMAIL_SETUP_KEY = 'agent_email.setup';
const SETUP_ATTEMPT_KEY_PREFIX = 'agent_email.setup_attempt:';

const mainDomainChangeSchema = v.object({
  type: v.string(),
  name: v.string(),
  content: v.nullable(v.string()),
  change: v.picklist(['add', 'remove']),
});
const setupRecordSchema = v.object({
  domain: v.string(),
  enabledAt: v.string(),
  mainDomainChanges: v.optional(v.array(mainDomainChangeSchema), []),
  zoneChanges: v.optional(v.array(v.string()), []),
});
const mailRecordSchema = v.object({
  type: v.string(),
  content: v.string(),
  priority: v.optional(v.number()),
});
const setupAttemptSchema = v.object({
  domain: v.string(),
  startedAt: v.string(),
  startedBy: v.string(),
  /** The main domain's MX and SPF records before the setup changed anything. */
  baseline: v.array(mailRecordSchema),
  /** Records the admin allowed Cloudflare to add. */
  allowed: v.array(mailRecordSchema),
  removed: v.optional(v.array(mailRecordSchema)),
  /** Zone settings the admin allowed the setup to change. */
  zoneChanges: v.array(v.picklist(['subaddressing'])),
  /** The run that holds the lease, and when it lapses. Absent in rows older than the lease. */
  owner: v.optional(v.nullable(v.string()), null),
  leaseUntil: v.optional(v.nullable(v.string()), null),
});

export type AgentEmailSetupRecord = v.InferOutput<typeof setupRecordSchema>;
export type AgentEmailSetupAttempt = v.InferOutput<typeof setupAttemptSchema>;
export type AgentEmailMailRecord = v.InferOutput<typeof mailRecordSchema>;

/** An attempt as stored; `stored` is the exact value, for compare-and-set. */
export interface StoredSetupAttempt {
  attempt: AgentEmailSetupAttempt;
  stored: string;
}

/** The deploy prepared agent email: the send binding exists. */
export function hasAgentEmailBinding(env: Pick<Env, 'AGENT_EMAIL' | 'BASE_DOMAIN'>): boolean {
  return Boolean(env.AGENT_EMAIL && env.BASE_DOMAIN?.trim());
}

function parseStored<TSchema extends v.GenericSchema>(
  schema: TSchema,
  raw: string,
  key: string
): v.InferOutput<TSchema> | null {
  try {
    const parsed = v.safeParse(schema, JSON.parse(raw));
    if (parsed.success) return parsed.output;
  } catch {
    // Reported below.
  }
  log.error('agent_email.setup_record_unreadable', { key });
  return null;
}

/** Throws when the store cannot be read; callers apply their own outage policy. */
export async function readAgentEmailSetup(env: Env): Promise<AgentEmailSetupRecord | null> {
  const raw = (await readSetting(env, AGENT_EMAIL_SETUP_KEY)).value;
  return raw ? parseStored(setupRecordSchema, raw, AGENT_EMAIL_SETUP_KEY) : null;
}

/** On: the deploy prepared it and an admin set it up for the current agent email domain. */
export async function isAgentEmailOn(env: Env): Promise<boolean> {
  if (!hasAgentEmailBinding(env)) return false;
  const record = await readAgentEmailSetup(env);
  return record?.domain === agentEmailDomain(env.BASE_DOMAIN);
}

/** `GET /api/config/agent-email`. A store outage reports agent email as off. */
export async function agentEmailConfig(env: Env): Promise<AgentEmailConfigResponse> {
  let enabled = false;
  try {
    enabled = await isAgentEmailOn(env);
  } catch (error) {
    log.error('agent_email.config_unavailable', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return { enabled, domain: enabled ? agentEmailDomain(env.BASE_DOMAIN) : null };
}

/** The sender, only while agent email is on. */
export async function activeAgentEmailSender(env: Env): Promise<AgentEmailSender | null> {
  return (await isAgentEmailOn(env)) ? agentEmailSenderFor(env) : null;
}

function setupAttemptKey(domain: string): string {
  return `${SETUP_ATTEMPT_KEY_PREFIX}${domain}`;
}

/** The attempt for `domain`, if a setup is running or stopped part-way. Throws if unreadable. */
export async function readSetupAttempt(
  env: Env,
  domain: string
): Promise<StoredSetupAttempt | null> {
  const key = setupAttemptKey(domain);
  const stored = (await readSetting(env, key)).value;
  if (!stored) return null;
  const attempt = parseStored(setupAttemptSchema, stored, key);
  // Refuse rather than start over: starting over would drop the baseline this record keeps.
  if (!attempt || attempt.domain !== domain) {
    throw new Error(`The agent email setup record ${key} is unreadable`);
  }
  return { attempt, stored };
}

/**
 * Records `attempt` unless an attempt for its domain exists already, and returns the one
 * stored: the first run's baseline wins, so a concurrent run checks against it too. The insert
 * goes to the primary, so the read after it sees any attempt it lost to.
 */
export async function claimSetupAttempt(
  env: Env,
  attempt: AgentEmailSetupAttempt
): Promise<StoredSetupAttempt> {
  await env.DATABASE.prepare(
    `INSERT INTO platform_settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO NOTHING`
  )
    .bind(
      setupAttemptKey(attempt.domain),
      JSON.stringify(attempt),
      attempt.startedAt,
      attempt.startedBy
    )
    .run();
  const stored = await readSetupAttempt(env, attempt.domain);
  if (!stored) throw new Error('The agent email setup record disappeared while it was claimed');
  return stored;
}

/** Replaces `previous` with `next` only if no other run changed it since; false if one did. */
export async function replaceSetupAttempt(
  env: Env,
  previous: StoredSetupAttempt,
  next: AgentEmailSetupAttempt
): Promise<boolean> {
  const result = await env.DATABASE.prepare(
    `UPDATE platform_settings SET value = ?, updated_at = ?, updated_by = ?
     WHERE key = ? AND value = ?`
  )
    .bind(
      JSON.stringify(next),
      next.startedAt,
      next.startedBy,
      setupAttemptKey(next.domain),
      previous.stored
    )
    .run();
  return result.meta.changes === 1;
}

/**
 * Turns agent email on and drops the attempt, in one transaction, only while `owned` is still
 * the stored attempt and its lease has not lapsed: a run whose lease lapsed or was taken over
 * cannot finish. False if it could not.
 *
 * The database's clock decides the lease, when the transaction runs, so a batch that arrives
 * late cannot finish on time it no longer has. That decision is made once: the first statement
 * marks the attempt as finishing, and the on-switch and the drop follow that mark.
 */
export async function completeAgentEmailSetup(
  env: Env,
  record: AgentEmailSetupRecord,
  updatedBy: string,
  owned: StoredSetupAttempt
): Promise<boolean> {
  // The mark names this run's lease, so no other run can have written it.
  if (!owned.attempt.owner) return false;
  const attemptKey = setupAttemptKey(record.domain);
  const finishing = JSON.stringify({ ...owned.attempt, finishing: true });
  const [decided] = await env.DATABASE.batch([
    env.DATABASE.prepare(
      `UPDATE platform_settings SET value = ?
       WHERE key = ? AND value = ?
         AND julianday(json_extract(value, '$.leaseUntil')) > julianday('now')`
    ).bind(finishing, attemptKey, owned.stored),
    env.DATABASE.prepare(
      `INSERT INTO platform_settings (key, value, updated_at, updated_by)
       SELECT ?, ?, ?, ?
       WHERE EXISTS (SELECT 1 FROM platform_settings WHERE key = ? AND value = ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at,
         updated_by = excluded.updated_by`
    ).bind(
      AGENT_EMAIL_SETUP_KEY,
      JSON.stringify(record),
      record.enabledAt,
      updatedBy,
      attemptKey,
      finishing
    ),
    env.DATABASE.prepare(`DELETE FROM platform_settings WHERE key = ? AND value = ?`).bind(
      attemptKey,
      finishing
    ),
  ]);
  return decided?.meta.changes === 1;
}
