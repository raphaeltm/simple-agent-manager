/**
 * Agent email's on-switch (preview). The deploy only prepares agent email: Email Sending for
 * `agents.<BASE_DOMAIN>` and the `AGENT_EMAIL` send binding. A superadmin turns it on with the
 * admin setup (`./setup.ts`), which writes the record kept here. Agent email is on only when
 * the binding exists and that record names the current agent email domain, so a deployment
 * whose binding ships before anyone ran the setup refuses inbound mail and replies.
 */
import type { AgentEmailConfigResponse } from '@simple-agent-manager/shared';
import * as v from 'valibot';

import type { Env } from '../../env';
import { resolveD1BindingIdentity } from '../../lib/d1-session';
import { log } from '../../lib/logger';
import { ADMIN_SETTINGS_CACHE_MAX_MS } from '../admin-settings-cache';
import { readSetting, writeSetting } from '../platform-config-store';
import { agentEmailDomain } from './address';
import { type AgentEmailSender, agentEmailSenderFor } from './provider';

/** `platform_settings` key of the setup record. Not an admin setting: only the setup writes it. */
export const AGENT_EMAIL_SETUP_KEY = 'agent_email.setup';

const setupRecordSchema = v.object({
  domain: v.string(),
  enabledAt: v.string(),
  mainDomainChanges: v.array(
    v.object({ type: v.string(), name: v.string(), content: v.nullable(v.string()) })
  ),
});

export type AgentEmailSetupRecord = v.InferOutput<typeof setupRecordSchema>;

/** The deploy prepared agent email: the send binding exists. */
export function hasAgentEmailBinding(env: Pick<Env, 'AGENT_EMAIL' | 'BASE_DOMAIN'>): boolean {
  return Boolean(env.AGENT_EMAIL && env.BASE_DOMAIN?.trim());
}

function parseSetupRecord(raw: string | null): AgentEmailSetupRecord | null {
  if (!raw) return null;
  try {
    const parsed = v.safeParse(setupRecordSchema, JSON.parse(raw));
    if (parsed.success) return parsed.output;
  } catch {
    // Reported below; an unreadable record leaves agent email off.
  }
  log.error('agent_email.setup_record_unreadable', { key: AGENT_EMAIL_SETUP_KEY });
  return null;
}

// Per-isolate cache of a present record, which only the setup writes and the inbound, config
// and trigger paths all read. It is held for the admin settings cache ceiling, the bound every
// other admin-written platform setting already uses. An absent record is not cached, so turning agent email on takes
// effect on every isolate at once; nothing turns it off except a deploy without the binding or
// a new BASE_DOMAIN, both checked on every call.
let cache = new WeakMap<D1Database, { record: AgentEmailSetupRecord; expiresAt: number }>();

/** Throws when the store cannot be read; callers apply their own outage policy. */
export async function readAgentEmailSetup(env: Env): Promise<AgentEmailSetupRecord | null> {
  const key = resolveD1BindingIdentity(env.DATABASE);
  const cached = key ? cache.get(key) : undefined;
  if (cached && cached.expiresAt > Date.now()) return cached.record;
  const record = parseSetupRecord((await readSetting(env, AGENT_EMAIL_SETUP_KEY)).value);
  if (key && record)
    cache.set(key, { record, expiresAt: Date.now() + ADMIN_SETTINGS_CACHE_MAX_MS });
  return record;
}

export async function recordAgentEmailSetup(
  env: Env,
  record: AgentEmailSetupRecord,
  updatedBy: string
): Promise<void> {
  await writeSetting(env, AGENT_EMAIL_SETUP_KEY, JSON.stringify(record), updatedBy);
  const key = resolveD1BindingIdentity(env.DATABASE);
  if (key) cache.set(key, { record, expiresAt: Date.now() + ADMIN_SETTINGS_CACHE_MAX_MS });
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

export function __resetAgentEmailSetupCacheForTest(): void {
  cache = new WeakMap();
}
