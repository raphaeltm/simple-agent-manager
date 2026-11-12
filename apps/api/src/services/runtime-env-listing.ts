/**
 * The runtime env names an agent session can actually use, with scope, expiry and provenance,
 * and never a value. Applies the same project → profile → skill precedence and the same
 * expiry rule as `getSecretExecutionEnv`, so a listed secret name is one exec will accept.
 */
import type { EffectiveRuntimeEnvEntry, RuntimeEnvScope } from '@simple-agent-manager/shared';
import { and, eq } from 'drizzle-orm';

import * as schema from '../db/schema';
import { errors } from '../middleware/error';
import {
  collectedProvenanceColumns,
  type Db,
  isoOrNull,
  toCollectedProvenance,
} from './runtime-secret-request-records';
import {
  projectRuntimeEnvUnexpired,
  resolveWorkspaceRuntimeAssetContext,
  type RuntimeAssetContextInput,
} from './workspace-runtime-assets';

interface ScopedRow {
  name: string;
  isSecret: boolean;
  expiresAt: number | null;
  collected: EffectiveRuntimeEnvEntry['collected'];
}

async function projectRows(db: Db, projectId: string): Promise<ScopedRow[]> {
  const rows = await db
    .select({
      name: schema.projectRuntimeEnvVars.envKey,
      isSecret: schema.projectRuntimeEnvVars.isSecret,
      expiresAt: schema.projectRuntimeEnvVars.expiresAt,
      ...collectedProvenanceColumns,
    })
    .from(schema.projectRuntimeEnvVars)
    .leftJoin(
      schema.runtimeSecretRequests,
      and(
        eq(schema.runtimeSecretRequests.id, schema.projectRuntimeEnvVars.secretRequestId),
        eq(schema.runtimeSecretRequests.projectId, schema.projectRuntimeEnvVars.projectId)
      )
    )
    .leftJoin(schema.users, eq(schema.users.id, schema.runtimeSecretRequests.resolvedBy))
    .where(
      and(eq(schema.projectRuntimeEnvVars.projectId, projectId), projectRuntimeEnvUnexpired())
    );
  return rows.map((row) => ({
    name: row.name,
    isSecret: row.isSecret,
    expiresAt: row.expiresAt ?? null,
    collected: toCollectedProvenance(row),
  }));
}

export async function listEffectiveRuntimeEnv(
  db: Db,
  input: RuntimeAssetContextInput,
  caller: { userId: string; projectId: string }
): Promise<{
  entries: EffectiveRuntimeEnvEntry[];
  profileId: string | null;
  skillId: string | null;
}> {
  const context = await resolveWorkspaceRuntimeAssetContext(db, input);
  // Same scope check as exec_with_secrets: the workspace must be the caller's, in its project.
  if (context.userId !== caller.userId || context.projectId !== caller.projectId) {
    throw errors.forbidden('Runtime env scope does not match the session');
  }
  if (!context.projectId) return { entries: [], profileId: null, skillId: null };
  const [project, profile, skill] = await Promise.all([
    projectRows(db, context.projectId),
    context.agentProfileId
      ? db
          .select({
            name: schema.profileRuntimeEnvVars.envKey,
            isSecret: schema.profileRuntimeEnvVars.isSecret,
          })
          .from(schema.profileRuntimeEnvVars)
          .where(eq(schema.profileRuntimeEnvVars.profileId, context.agentProfileId))
      : Promise.resolve([]),
    context.skillId
      ? db
          .select({
            name: schema.skillRuntimeEnvVars.envKey,
            isSecret: schema.skillRuntimeEnvVars.isSecret,
          })
          .from(schema.skillRuntimeEnvVars)
          .where(eq(schema.skillRuntimeEnvVars.skillId, context.skillId))
      : Promise.resolve([]),
  ]);

  const byName = new Map<string, EffectiveRuntimeEnvEntry>();
  const apply = (scope: RuntimeEnvScope, rows: ScopedRow[]) => {
    for (const row of rows) {
      const hidden = byName.get(row.name);
      byName.set(row.name, {
        name: row.name,
        scope,
        isSecret: row.isSecret,
        overrides: hidden ? [...hidden.overrides, hidden.scope] : [],
        expiresAt: isoOrNull(row.expiresAt),
        collected: row.collected,
      });
    }
  };
  apply('project', project);
  apply(
    'profile',
    profile.map((row) => ({ ...row, expiresAt: null, collected: null }))
  );
  apply(
    'skill',
    skill.map((row) => ({ ...row, expiresAt: null, collected: null }))
  );
  const entries = [...byName.values()].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0
  );
  return { entries, profileId: context.agentProfileId, skillId: context.skillId };
}
