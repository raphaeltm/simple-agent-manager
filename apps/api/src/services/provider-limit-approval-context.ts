import { type drizzle } from 'drizzle-orm/d1';
import * as v from 'valibot';

import type * as schema from '../db/schema';
import type { Env } from '../env';
import { AppError } from '../middleware/error';
import { resolveAgentProfile } from './agent-profiles';

const SnapshotRow = v.object({
  id: v.pipe(v.string(), v.nonEmpty()),
  recovery_status: v.nullable(v.picklist(['waking', 'failed'])),
  recovery_task_id: v.nullable(v.string()),
  recovery_attempt_id: v.nullable(v.string()),
  updated_at: v.pipe(v.string(), v.nonEmpty()),
  agent_type: v.pipe(v.string(), v.nonEmpty()),
  agent_profile_id: v.nullable(v.string()),
  agent_credential_reference: v.nullable(v.string()),
  agent_credential_generation: v.pipe(v.number(), v.integer(), v.minValue(0)),
});

export function parseProviderLimitSnapshotRow(raw: unknown) {
  const parsed = v.safeParse(SnapshotRow, raw);
  return parsed.success ? parsed.output : null;
}

/** Same explicit ID/project-name/global-name resolution as normal dispatch.
 * Undefined means an invalid explicit hint; it must never inherit null consent. */
export async function resolveProviderLimitProfileId(
  db: ReturnType<typeof drizzle<typeof schema>>,
  env: Pick<Env, 'DEFAULT_TASK_AGENT_TYPE'>,
  task: { projectId: string; userId: string; agentProfileHint: string | null }
): Promise<string | null | undefined> {
  if (task.agentProfileHint === null) return null;
  if (!task.agentProfileHint.trim()) return undefined;
  try {
    return (await resolveAgentProfile(db, task.projectId, task.agentProfileHint, task.userId, env))
      .profileId;
  } catch (error) {
    if (error instanceof AppError && error.statusCode === 404) return undefined;
    // Transient storage failures must retain the durable approval for retry.
    throw error;
  }
}
