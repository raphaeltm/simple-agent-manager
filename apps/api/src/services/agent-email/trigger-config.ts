/** Email trigger configuration persistence (trigger_email_configs). */
import type { EmailTriggerConfig } from '@simple-agent-manager/shared';
import { eq } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/d1';

import * as schema from '../../db/schema';
import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { errors } from '../../middleware/error';
import { agentEmailAddress, normalizeMailbox } from './address';
import { getAgentEmailLimits } from './settings';
import { isAgentEmailOn } from './setup-state';

type Database = ReturnType<typeof drizzle<typeof schema>>;

export function parseAllowedSenders(json: string): string[] {
  try {
    const value: unknown = JSON.parse(json);
    if (!Array.isArray(value)) return [];
    return value.filter((entry): entry is string => typeof entry === 'string');
  } catch {
    return [];
  }
}

export function toEmailTriggerConfig(
  row: Pick<schema.TriggerEmailConfigRow, 'addressKey' | 'allowedSendersJson'>,
  baseDomain: string
): EmailTriggerConfig {
  return {
    address: agentEmailAddress(baseDomain, row.addressKey),
    allowedSenders: parseAllowedSenders(row.allowedSendersJson),
  };
}

export async function requireAgentEmailOn(env: Env): Promise<void> {
  if (!(await isAgentEmailOn(env))) {
    throw errors.conflict('Email triggers are not available on this deployment');
  }
}

/**
 * Normalize, dedupe and bound an allowed-sender list. Omitted on create means
 * "only the creator": the user's account email.
 */
export async function resolveAllowedSenders(
  db: Database,
  env: Env,
  userId: string,
  requested: string[] | undefined
): Promise<string[]> {
  let senders = requested;
  if (!senders) {
    const user = await db
      .select({ email: schema.users.email })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .get();
    senders = user?.email ? [user.email] : [];
  }
  const normalized = [...new Set(senders.map((sender) => normalizeMailbox(sender)))];
  if (normalized.includes(null)) throw errors.badRequest('Each allowed sender must be an email');
  const valid = normalized.filter((sender): sender is string => sender !== null);
  if (valid.length === 0) throw errors.badRequest('Add at least one allowed sender');
  const { maxAllowedSenders } = await getAgentEmailLimits(env);
  if (valid.length > maxAllowedSenders) {
    throw errors.badRequest(`At most ${maxAllowedSenders} allowed senders per email trigger`);
  }
  return valid;
}

/** Attach the address and allowed senders to an email trigger's API response. */
export async function loadEmailTriggerConfig(
  db: Database,
  env: Env,
  triggerId: string
): Promise<EmailTriggerConfig | undefined> {
  const row = await db
    .select()
    .from(schema.triggerEmailConfigs)
    .where(eq(schema.triggerEmailConfigs.triggerId, triggerId))
    .get();
  if (!row) {
    log.warn('trigger.email_config_missing', { triggerId });
    return undefined;
  }
  return toEmailTriggerConfig(row, env.BASE_DOMAIN);
}
