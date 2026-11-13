/**
 * The account a person chooses for one run, over the account its profile would use.
 *
 * Checked once at submit, before any task effect, and stored on the task
 * (`tasks.agent_configuration_id`). Every later resolution of the run's agent
 * credential reads it through `resolveSessionProfileCredentialContext` or
 * provider-limit admission, and the shared resolver halts (never falls back) if the
 * account stops being usable after submit. So this check is about a clear 400 for
 * the person submitting; the resolver is the boundary that keeps it safe.
 */
import { and, eq } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import { errors } from '../middleware/error';

type Db = ReturnType<typeof drizzle<typeof schema>>;

/**
 * Validate `configurationId` as one of the caller's own active agent accounts for the
 * agent this run starts. Returns the id to store, or null when no account was chosen.
 * Another person's id reads as not found, so the response says nothing about it.
 */
export async function validateRunAgentConfiguration(
  db: Db,
  input: { userId: string; configurationId: string | null | undefined; agentType: string }
): Promise<string | null> {
  const configurationId = input.configurationId?.trim();
  if (!configurationId) return null;

  const rows = await db
    .select({
      consumerKind: schema.ccConfigurations.consumerKind,
      consumerTarget: schema.ccConfigurations.consumerTarget,
      configurationActive: schema.ccConfigurations.isActive,
      credentialId: schema.ccConfigurations.credentialId,
      credentialActive: schema.ccCredentials.isActive,
      credentialOwnerId: schema.ccCredentials.ownerId,
    })
    .from(schema.ccConfigurations)
    .leftJoin(
      schema.ccCredentials,
      eq(schema.ccCredentials.id, schema.ccConfigurations.credentialId)
    )
    .where(
      and(
        eq(schema.ccConfigurations.id, configurationId),
        eq(schema.ccConfigurations.ownerId, input.userId)
      )
    )
    .limit(1);

  const row = rows[0];
  if (!row || row.consumerKind !== 'agent') {
    throw errors.badRequest('That account was not found. Choose another account for this chat.');
  }
  if (row.consumerTarget !== input.agentType) {
    throw errors.badRequest(
      `That account is for ${row.consumerTarget}, but this chat runs ${input.agentType}.`
    );
  }
  // A configuration without a credential (a proxy-mode binding) has nothing to pause.
  const credentialUsable =
    row.credentialId === null ||
    (row.credentialActive === true && row.credentialOwnerId === input.userId);
  if (!row.configurationActive || !credentialUsable) {
    throw errors.badRequest('That account is paused. Choose another account for this chat.');
  }
  return configurationId;
}
