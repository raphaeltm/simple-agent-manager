/**
 * Where a signed webhook automation stands: is a secret saved, has anything arrived, and why the
 * last call was refused. Everything is derived from the stored secret and the call log, so a
 * person or a different agent can pick up an interrupted setup from this read alone.
 *
 * Shared by the REST trigger read and MCP `get_trigger`.
 */
import {
  isWebhookSignedScheme,
  WEBHOOK_SIGNING_SECRET_ANCHOR,
  type WebhookDeliveryOutcome,
  type WebhookRejectionReason,
  type WebhookSetupState,
  type WebhookSetupStatus,
  type WebhookTriggerConfig,
} from '@simple-agent-manager/shared';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import type * as schema from '../db/schema';
import * as dbSchema from '../db/schema';
import type { Env } from '../env';
import { getAppOrigin } from '../lib/app-origin';
import { toWebhookTriggerConfig, webhookRowScheme } from './webhook-trigger-config-rows';

/**
 * Outcomes that mean a verified event reached the automation, whatever was then done with it.
 * A positive list: a new outcome does not count as "receiving" until it is added here.
 */
const EVENT_OUTCOMES: readonly WebhookDeliveryOutcome[] = [
  'accepted',
  'queued',
  'duplicate',
  'filtered',
  'inactive',
  'dropped',
  'queue_full',
];

const REJECTION_HINTS: Record<WebhookRejectionReason, string> = {
  not_configured: 'No usable signing secret is saved. Save it on the automation page.',
  invalid_signature:
    "The signature did not match. Check that the saved signing secret is the sender's current one and that nothing rewrites the request on its way to SAM.",
  stale_timestamp:
    "The request's timestamp is too old or too far ahead. The sender is replaying an old request or its clock is wrong.",
  invalid_body: 'The request body was not a JSON object.',
  missing_event_id:
    'Events are arriving without a readable ID at the configured location, so SAM cannot tell retries apart and starts nothing.',
  repeated_body:
    'A signed body SAM already took arrived again under a different event ID. The signature does not cover a header ID, so SAM starts nothing: it may be a replay. If the service sends identical bodies for different events, read the event ID from the body instead.',
};

export function webhookRejectionHint(reason: string): string {
  return (REJECTION_HINTS as Record<string, string | undefined>)[reason] ?? 'SAM refused the call.';
}

/** The automation page, where someone with write access saves the secret. Not a credential. */
export function webhookSecretEntryUrl(
  env: Pick<Env, 'BASE_DOMAIN'>,
  projectId: string,
  triggerId: string
): string {
  return `${getAppOrigin(env)}/projects/${encodeURIComponent(projectId)}/automation/trigger/${encodeURIComponent(triggerId)}#${WEBHOOK_SIGNING_SECRET_ANCHOR}`;
}

/**
 * Where setup stands. `secretSetAt` is when the current signing secret was saved, null when none
 * is. Only calls received since then count: a refusal from before the secret was saved or
 * replaced describes a setup that no longer exists, and must not keep the status at "refused".
 */
export async function readWebhookSetupStatus(
  env: Env,
  trigger: Pick<schema.TriggerRow, 'id' | 'projectId'>,
  secretSetAt: string | null
): Promise<WebhookSetupStatus> {
  const since = secretSetAt ?? '';
  const [latest, rejection, waiting] = await env.DATABASE.batch<{
    outcome?: string;
    errorCode?: string | null;
    receivedAt?: string;
    count?: number;
  }>([
    // The latest call that says something about the connection. Slack's address check and
    // SAM's own faults say nothing either way, so they are left out.
    env.DATABASE.prepare(
      `SELECT outcome, received_at AS receivedAt FROM webhook_deliveries
        WHERE trigger_id = ? AND outcome IN (${[...EVENT_OUTCOMES, 'rejected'].map((o) => `'${o}'`).join(', ')})
          AND received_at >= ?
        ORDER BY received_at DESC, id DESC LIMIT 1`
    ).bind(trigger.id, since),
    env.DATABASE.prepare(
      `SELECT error_code AS errorCode, received_at AS receivedAt FROM webhook_deliveries
        WHERE trigger_id = ? AND outcome = 'rejected' AND received_at >= ?
        ORDER BY received_at DESC, id DESC LIMIT 1`
    ).bind(trigger.id, since),
    env.DATABASE.prepare(
      `SELECT COUNT(*) AS count FROM trigger_executions
        WHERE trigger_id = ? AND status = 'waiting' AND queue_expires_at > ?`
    ).bind(trigger.id, new Date().toISOString()),
  ]);
  const last = latest?.results[0];
  const rejected = rejection?.results[0];
  let state: WebhookSetupState;
  if (secretSetAt === null) state = 'needs_secret';
  else if (!last?.outcome) state = 'waiting_for_first_request';
  else state = last.outcome === 'rejected' ? 'rejecting' : 'receiving';
  const lastEvent = state === 'receiving' ? last : undefined;
  return {
    state,
    secretEntryUrl: webhookSecretEntryUrl(env, trigger.projectId, trigger.id),
    lastEventAt: lastEvent?.receivedAt ?? null,
    waiting: Number(waiting?.results[0]?.count ?? 0),
    lastRejection:
      rejected?.receivedAt && rejected.errorCode
        ? {
            reason: rejected.errorCode,
            at: rejected.receivedAt,
            hint: webhookRejectionHint(rejected.errorCode),
          }
        : null,
  };
}

/**
 * The safe configuration for one webhook automation, with setup status when it is a signed one.
 * Every single-automation read (REST, MCP `get_trigger`, MCP `create_trigger`) goes through here.
 */
export async function readWebhookTriggerConfig(
  env: Env,
  trigger: Pick<schema.TriggerRow, 'id' | 'projectId'>
): Promise<WebhookTriggerConfig | undefined> {
  const row = await drizzle(env.DATABASE, { schema: dbSchema })
    .select()
    .from(dbSchema.webhookTriggerConfigs)
    .where(eq(dbSchema.webhookTriggerConfigs.triggerId, trigger.id))
    .get();
  if (!row) return undefined;
  const config = toWebhookTriggerConfig(row, env);
  if (!isWebhookSignedScheme(webhookRowScheme(row))) return config;
  return {
    ...config,
    setup: await readWebhookSetupStatus(
      env,
      trigger,
      config.signingSecret?.set ? (config.signingSecret.setAt ?? '') : null
    ),
  };
}
