/**
 * API-side credential resolver — the bridge between D1 and the pure shared resolver.
 *
 * Call sites (getDecryptedAgentKey, createProviderForUser) delegate here when the
 * composable-credentials tables have been backfilled for a user.
 */

import { drizzle } from 'drizzle-orm/d1';
import {
  resolveEnvironment,
  agentAssembler,
  computeAssembler,
  type CCConsumerRef,
  type CCResolvedEnvironment,
  type CCResolutionContext,
  type CCEnvInjection,
  type CCProviderConfig,
} from '@simple-agent-manager/shared';
import { buildSnapshot } from './snapshot';

export type { CCEnvInjection, CCProviderConfig };

/**
 * Resolve a credential for a consumer (agent or compute) using the composable model.
 * Returns null when no credential is available (including Rule 28 inactive-halt).
 */
export async function resolveForConsumer(
  db: ReturnType<typeof drizzle>,
  userId: string,
  encryptionKey: string,
  consumer: CCConsumerRef,
  projectId?: string | null,
): Promise<CCResolvedEnvironment | null> {
  const snapshot = await buildSnapshot(db, userId, encryptionKey, projectId);
  const ctx: CCResolutionContext = { userId, projectId: projectId ?? undefined };
  return resolveEnvironment(snapshot, consumer, ctx);
}

/**
 * Resolve and assemble environment variables for an agent consumer.
 * This is the composable-credentials replacement for getDecryptedAgentKey.
 */
export async function resolveAgentEnv(
  db: ReturnType<typeof drizzle>,
  userId: string,
  encryptionKey: string,
  agentType: string,
  projectId?: string | null,
): Promise<CCEnvInjection | null> {
  const consumer: CCConsumerRef = { kind: 'agent', agentType };
  const resolved = await resolveForConsumer(db, userId, encryptionKey, consumer, projectId);
  if (!resolved) return null;
  return agentAssembler.assemble(resolved);
}

/**
 * Resolve and assemble provider config for a compute consumer.
 * This is the composable-credentials replacement for createProviderForUser.
 */
export async function resolveComputeConfig(
  db: ReturnType<typeof drizzle>,
  userId: string,
  encryptionKey: string,
  provider: string,
  projectId?: string | null,
): Promise<CCProviderConfig | null> {
  const consumer: CCConsumerRef = { kind: 'compute', provider };
  const resolved = await resolveForConsumer(db, userId, encryptionKey, consumer, projectId);
  if (!resolved) return null;
  return computeAssembler.assemble(resolved);
}
