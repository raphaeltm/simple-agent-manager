import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';

interface RecoveryTarget {
  nodeId: string;
  workspaceId: string;
}

export async function persistWakeDegraded(
  env: Env,
  target: RecoveryTarget,
  rawMessage: string
): Promise<string> {
  const diagnostic = rawMessage.toLowerCase().includes('timeout')
    ? 'Runtime recovery timed out; transcript and partial output remain available.'
    : 'Runtime recovery is degraded; transcript and partial output remain available.';
  const now = new Date().toISOString();
  const db = drizzle(env.DATABASE, { schema });
  await db
    .update(schema.workspaces)
    .set({ status: 'recovery', errorMessage: diagnostic, updatedAt: now })
    .where(eq(schema.workspaces.id, target.workspaceId));
  await db
    .update(schema.agentSessions)
    .set({ status: 'recovery', errorMessage: diagnostic, updatedAt: now })
    .where(eq(schema.agentSessions.workspaceId, target.workspaceId));
  return diagnostic;
}

export async function persistRecoveryExhausted(env: Env, target: RecoveryTarget): Promise<string> {
  const diagnostic =
    'Runtime recovery attempts exhausted; transcript and partial output remain available.';
  const now = new Date().toISOString();
  const db = drizzle(env.DATABASE, { schema });
  await db
    .update(schema.nodes)
    .set({
      status: 'error',
      healthStatus: 'unhealthy',
      errorMessage: diagnostic,
      updatedAt: now,
    })
    .where(eq(schema.nodes.id, target.nodeId));
  await db
    .update(schema.workspaces)
    .set({ status: 'error', errorMessage: diagnostic, updatedAt: now })
    .where(eq(schema.workspaces.id, target.workspaceId));
  await db
    .update(schema.agentSessions)
    .set({ status: 'error', errorMessage: diagnostic, updatedAt: now })
    .where(eq(schema.agentSessions.workspaceId, target.workspaceId));
  return diagnostic;
}
