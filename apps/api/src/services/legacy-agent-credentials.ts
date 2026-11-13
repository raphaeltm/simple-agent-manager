/**
 * Which row of the legacy `credentials` table an agent run would use, before the person has any
 * composable-credential (cc_*) rows. The one implementation shared by the agent-key callback
 * (`resolveAgentKeyLegacy`, which then decrypts the chosen row) and selection-only reads
 * (`agent-credential-selection.ts`, which never decrypts).
 *
 * Rule 28: an inactive project-scoped row halts; it never falls back to the user-scoped row.
 */
import { and, asc, eq, isNull, or } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';

export interface LegacyAgentCredentialRow {
  id: string;
  projectId: string | null;
  agentType: string | null;
  isActive: boolean;
}

export type LegacyAgentCredentialPick<T extends LegacyAgentCredentialRow> =
  { kind: 'credential'; row: T; tier: 'project' | 'user' } | { kind: 'halted' } | null;

/** Pick from rows already scoped to one user (project-scoped and user-scoped agent keys). */
export function pickLegacyAgentCredential<T extends LegacyAgentCredentialRow>(
  rows: readonly T[],
  agentType: string,
  projectId: string | null | undefined
): LegacyAgentCredentialPick<T> {
  const forAgent = rows.filter((row) => row.agentType === agentType);
  if (projectId) {
    const projectRow = forAgent.find((row) => row.projectId === projectId);
    if (projectRow) {
      return projectRow.isActive
        ? { kind: 'credential', row: projectRow, tier: 'project' }
        : { kind: 'halted' };
    }
  }
  const userRow = forAgent.find((row) => row.projectId === null && row.isActive);
  return userRow ? { kind: 'credential', row: userRow, tier: 'user' } : null;
}

/**
 * The user's agent-key rows that can apply in `projectId` (user-scoped, plus that project's),
 * optionally for one agent. Ordered by id so the pick is deterministic.
 */
export async function loadLegacyAgentCredentialRows(
  db: ReturnType<typeof drizzle>,
  userId: string,
  projectId: string | null | undefined,
  agentType?: string
) {
  return db
    .select()
    .from(schema.credentials)
    .where(
      and(
        eq(schema.credentials.userId, userId),
        eq(schema.credentials.credentialType, 'agent-api-key'),
        agentType ? eq(schema.credentials.agentType, agentType) : undefined,
        projectId
          ? or(isNull(schema.credentials.projectId), eq(schema.credentials.projectId, projectId))
          : isNull(schema.credentials.projectId)
      )
    )
    .orderBy(asc(schema.credentials.id));
}
