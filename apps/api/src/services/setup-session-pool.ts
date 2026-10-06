/**
 * Service wrapper for the SetupSessionPool singleton Durable Object.
 *
 * Resolves the `global` pool stub and forwards atomic lease/release calls. All
 * setup-session code goes through here rather than touching the DO namespace
 * directly, so the pool key and cap resolution live in one place.
 */
import type { LeaseResult,SetupSessionPool } from '../durable-objects/setup-session-pool';
import type { Env } from '../env';
import { getMaxConcurrentSetupSessions, getPoolLeaseMaxAgeMs } from './credential-setup-config';

const POOL_KEY = 'global';

function getStub(env: Env): DurableObjectStub<SetupSessionPool> {
  if (!env.SETUP_SESSION_POOL) {
    throw new Error('SETUP_SESSION_POOL Durable Object binding is not available');
  }
  const id = env.SETUP_SESSION_POOL.idFromName(POOL_KEY);
  return env.SETUP_SESSION_POOL.get(id) as DurableObjectStub<SetupSessionPool>;
}

/** Attempt to lease a concurrency slot for a new setup session. */
export async function leaseSetupSlot(env: Env, sessionId: string): Promise<LeaseResult> {
  const cap = getMaxConcurrentSetupSessions(env);
  const maxLeaseAgeMs = getPoolLeaseMaxAgeMs(env);
  return getStub(env).lease(sessionId, cap, maxLeaseAgeMs);
}

/** Release a previously leased slot. Safe to call with a null/undefined lease. */
export async function releaseSetupSlot(env: Env, leaseId: string | null | undefined): Promise<void> {
  if (!leaseId) return;
  await getStub(env).release(leaseId);
}
