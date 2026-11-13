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
import { log } from '../lib/logger';
import { errors } from '../middleware/error';
import type { ProfileCredentialContext } from './composable-credentials/profile-context';
import { explainForConsumer } from './composable-credentials/resolve';

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
  // A run account is a credential the person owns; a binding without one (proxy mode) is
  // not something they can choose per chat, and the resolver halts on it.
  if (row.credentialId === null || row.credentialOwnerId !== input.userId) {
    throw errors.badRequest('That account was not found. Choose another account for this chat.');
  }
  if (!row.configurationActive || row.credentialActive !== true) {
    throw errors.badRequest('That account is paused. Choose another account for this chat.');
  }
  return configurationId;
}

/**
 * The agent-key callback found no credential for a run that has a chosen account. If the
 * run tier halted (the account was paused, removed, or is not the owner's), refuse with a
 * 404 and a structured log instead of letting the caller continue to the platform proxy or
 * a fallback credential. A run tier that skipped (an account chosen for another agent)
 * returns, so that agent keeps its usual resolution. Called only on that miss, so the
 * extra resolution costs nothing on the normal path.
 */
export async function refuseHaltedRunAccount(
  db: Db,
  input: {
    workspaceId: string;
    userId: string;
    projectId: string | null;
    agentType: string;
    encryptionKey: string;
    profile: ProfileCredentialContext;
  }
): Promise<void> {
  const trace = await explainForConsumer(
    db,
    input.userId,
    input.encryptionKey,
    { kind: 'agent', agentType: input.agentType },
    input.projectId,
    input.profile
  );
  const runStep = trace.steps.find((step) => step.tier === 'run');
  if (runStep?.state !== 'halted') return;
  log.warn('agent_key.run_account_unavailable', {
    workspaceId: input.workspaceId,
    userId: input.userId,
    agentType: input.agentType,
    runConfigurationId: input.profile.runConfigurationId,
    reason: runStep.reason,
    action: 'rejected',
  });
  throw errors.notFound('The account chosen for this chat');
}
