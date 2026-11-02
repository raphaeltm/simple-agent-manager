import type { WorkspaceRuntimeAssetsResponse } from '@simple-agent-manager/shared';
import { and, eq, isNull, or, type SQL } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import { errors } from '../middleware/error';
import {
  getProfileRuntimeAssets,
  getSkillRuntimeAssets,
  mergeRuntimeAssetRows,
  resolveRuntimeEnvRows,
  resolveRuntimeFileRows,
  type RuntimeAssetRows,
} from './profile-runtime-assets';

type Db = ReturnType<typeof drizzle<typeof schema>>;

// This staging-only process selector must originate from the validated session
// profile, never from project or skill assets merged into the runtime env.
const codexC2CandidateEnv = 'SAM_CODEX_C2_CANDIDATE';

export interface RuntimeAssetContextInput {
  workspaceId: string;
  agentSessionId?: string | null;
}

export interface RuntimeAssetContext {
  workspaceId: string;
  projectId: string | null;
  userId: string;
  agentProfileId: string | null;
  skillId: string | null;
  source: 'agent-session' | 'task' | 'workspace' | 'none';
}

type WorkspaceRuntimeBase = {
  id: string;
  userId: string;
  projectId: string | null;
  agentProfileHint: string | null;
};

async function getWorkspaceRuntimeBase(db: Db, workspaceId: string): Promise<WorkspaceRuntimeBase> {
  const rows = await db
    .select({
      id: schema.workspaces.id,
      userId: schema.workspaces.userId,
      projectId: schema.workspaces.projectId,
      agentProfileHint: schema.workspaces.agentProfileHint,
    })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, workspaceId))
    .limit(1);

  const workspace = rows[0];
  if (!workspace) {
    throw errors.notFound('Workspace');
  }
  return workspace;
}

async function resolveAgentSessionRuntimeIds(
  db: Db,
  workspace: WorkspaceRuntimeBase,
  agentSessionId: string
): Promise<{ profileId: string | null; skillId: string | null }> {
  const rows = await db
    .select({
      id: schema.agentSessions.id,
      workspaceId: schema.agentSessions.workspaceId,
      userId: schema.agentSessions.userId,
      profileId: schema.agentSessions.agentProfileId,
      skillId: schema.agentSessions.skillId,
    })
    .from(schema.agentSessions)
    .where(eq(schema.agentSessions.id, agentSessionId))
    .limit(1);

  const session = rows[0];
  if (!session) {
    throw errors.notFound('Agent session');
  }
  if (session.workspaceId !== workspace.id || session.userId !== workspace.userId) {
    throw errors.forbidden('Agent session does not belong to workspace');
  }

  return {
    profileId: session.profileId ?? null,
    skillId: session.skillId ?? null,
  };
}

async function resolveTaskRuntimeIds(
  db: Db,
  workspace: WorkspaceRuntimeBase
): Promise<{ profileId: string | null; skillId: string | null }> {
  if (!workspace.projectId) {
    return { profileId: null, skillId: null };
  }

  const taskRows = await db
    .select({ profileId: schema.tasks.agentProfileHint, skillId: schema.tasks.skillId })
    .from(schema.tasks)
    .where(
      and(
        eq(schema.tasks.workspaceId, workspace.id),
        eq(schema.tasks.projectId, workspace.projectId),
        eq(schema.tasks.userId, workspace.userId)
      )
    )
    .limit(1);

  return {
    profileId: taskRows[0]?.profileId ?? null,
    skillId: taskRows[0]?.skillId ?? null,
  };
}

/**
 * A profile is valid for a run in `projectId` when it is one of that project's
 * profiles or the run's user's own global profile. The one predicate every caller
 * uses, including the credential profile context (`profile-context.ts`).
 */
export function profileValidForRunCondition(projectId: string | null, userId: string): SQL {
  const ownGlobalProfile = and(
    isNull(schema.agentProfiles.projectId),
    eq(schema.agentProfiles.userId, userId)
  ) as SQL;
  return projectId
    ? (or(eq(schema.agentProfiles.projectId, projectId), ownGlobalProfile) as SQL)
    : ownGlobalProfile;
}

async function validateProfileId(
  db: Db,
  workspace: WorkspaceRuntimeBase,
  profileId: string | null
): Promise<string | null> {
  if (!profileId || !workspace.projectId) return null;
  const rows = await db
    .select({ id: schema.agentProfiles.id })
    .from(schema.agentProfiles)
    .where(
      and(
        eq(schema.agentProfiles.id, profileId),
        profileValidForRunCondition(workspace.projectId, workspace.userId)
      )
    )
    .limit(1);
  if (!rows[0]) {
    throw errors.forbidden('Agent profile is not valid for workspace');
  }
  return rows[0].id;
}

async function validateSkillId(
  db: Db,
  workspace: WorkspaceRuntimeBase,
  skillId: string | null
): Promise<string | null> {
  if (!skillId || !workspace.projectId) return null;
  const rows = await db
    .select({ id: schema.skills.id })
    .from(schema.skills)
    .where(and(eq(schema.skills.id, skillId), eq(schema.skills.projectId, workspace.projectId)))
    .limit(1);
  if (!rows[0]) {
    throw errors.forbidden('Skill is not valid for workspace');
  }
  return rows[0].id;
}

async function resolveProjectAssets(
  db: Db,
  workspace: WorkspaceRuntimeBase,
  encryptionKey: string
): Promise<RuntimeAssetRows> {
  if (!workspace.projectId) {
    return { envVars: [], files: [] };
  }

  const [envRows, fileRows] = await Promise.all([
    db
      .select({
        key: schema.projectRuntimeEnvVars.envKey,
        storedValue: schema.projectRuntimeEnvVars.storedValue,
        valueIv: schema.projectRuntimeEnvVars.valueIv,
        isSecret: schema.projectRuntimeEnvVars.isSecret,
      })
      .from(schema.projectRuntimeEnvVars)
      .where(eq(schema.projectRuntimeEnvVars.projectId, workspace.projectId)),
    db
      .select({
        path: schema.projectRuntimeFiles.filePath,
        storedContent: schema.projectRuntimeFiles.storedContent,
        contentIv: schema.projectRuntimeFiles.contentIv,
        isSecret: schema.projectRuntimeFiles.isSecret,
      })
      .from(schema.projectRuntimeFiles)
      .where(eq(schema.projectRuntimeFiles.projectId, workspace.projectId)),
  ]);

  return {
    envVars: await resolveRuntimeEnvRows(envRows, encryptionKey),
    files: await resolveRuntimeFileRows(fileRows, encryptionKey),
  };
}

export interface WorkspaceRuntimeIds {
  workspace: WorkspaceRuntimeBase;
  /** Not yet validated against the workspace's project. */
  profileId: string | null;
  skillId: string | null;
  source: RuntimeAssetContext['source'];
}

/** Which profile and skill a workspace's run uses: agent session → task → workspace hint. */
export async function resolveWorkspaceRuntimeIds(
  db: Db,
  input: RuntimeAssetContextInput
): Promise<WorkspaceRuntimeIds> {
  const workspace = await getWorkspaceRuntimeBase(db, input.workspaceId);
  if (!workspace.projectId) {
    return { workspace, profileId: null, skillId: null, source: 'none' };
  }
  const agentSessionId = input.agentSessionId?.trim();
  if (agentSessionId) {
    const ids = await resolveAgentSessionRuntimeIds(db, workspace, agentSessionId);
    return { workspace, ...ids, source: 'agent-session' };
  }
  const taskIds = await resolveTaskRuntimeIds(db, workspace);
  if (taskIds.profileId || taskIds.skillId) return { workspace, ...taskIds, source: 'task' };
  if (workspace.agentProfileHint) {
    return { workspace, profileId: workspace.agentProfileHint, skillId: null, source: 'workspace' };
  }
  return { workspace, profileId: null, skillId: null, source: 'none' };
}

export async function resolveWorkspaceRuntimeAssetContext(
  db: Db,
  input: RuntimeAssetContextInput
): Promise<RuntimeAssetContext> {
  const { workspace, profileId, skillId, source } = await resolveWorkspaceRuntimeIds(db, input);
  const [agentProfileId, validSkillId] = await Promise.all([
    validateProfileId(db, workspace, profileId),
    validateSkillId(db, workspace, skillId),
  ]);

  return {
    workspaceId: workspace.id,
    projectId: workspace.projectId,
    userId: workspace.userId,
    agentProfileId,
    skillId: validSkillId,
    source,
  };
}

export async function getWorkspaceRuntimeAssets(
  db: Db,
  input: RuntimeAssetContextInput,
  encryptionKey: string
): Promise<WorkspaceRuntimeAssetsResponse> {
  const workspace = await getWorkspaceRuntimeBase(db, input.workspaceId);
  if (!workspace.projectId) {
    return {
      workspaceId: workspace.id,
      envVars: [],
      files: [],
    };
  }

  const context = await resolveWorkspaceRuntimeAssetContext(db, input);
  const projectAssets = await resolveProjectAssets(db, workspace, encryptionKey);
  const profileAssets = context.agentProfileId
    ? await getProfileRuntimeAssets(db, context.agentProfileId, workspace.userId, encryptionKey)
    : { envVars: [], files: [] };
  const skillAssets = context.skillId
    ? await getSkillRuntimeAssets(db, context.skillId, workspace.userId, encryptionKey)
    : { envVars: [], files: [] };
  const mergedAssets = mergeRuntimeAssetRows(projectAssets, profileAssets, skillAssets);
  const profileCandidate =
    context.source === 'agent-session'
      ? profileAssets.envVars.find((item) => item.key === codexC2CandidateEnv)
      : undefined;

  return {
    workspaceId: workspace.id,
    envVars: [
      ...mergedAssets.envVars.filter((item) => item.key !== codexC2CandidateEnv),
      ...(profileCandidate ? [profileCandidate] : []),
    ],
    files: mergedAssets.files,
  };
}

/** Merge stored rows before decrypting: overridden and unselected secrets never decrypt. */
export async function getSecretExecutionEnv(
  db: Db,
  input: RuntimeAssetContextInput,
  encryptionKey: string,
  secretNames: readonly string[]
): Promise<{
  context: RuntimeAssetContext;
  envVars: import('@simple-agent-manager/shared').WorkspaceRuntimeEnvVar[];
}> {
  if (!input.agentSessionId) throw errors.forbidden('An active agent session is required');
  const context = await resolveWorkspaceRuntimeAssetContext(db, input);
  const scopes = [
    {
      table: schema.projectRuntimeEnvVars,
      id: schema.projectRuntimeEnvVars.projectId,
      value: context.projectId,
    },
    {
      table: schema.profileRuntimeEnvVars,
      id: schema.profileRuntimeEnvVars.profileId,
      value: context.agentProfileId,
    },
    {
      table: schema.skillRuntimeEnvVars,
      id: schema.skillRuntimeEnvVars.skillId,
      value: context.skillId,
    },
  ];
  const merged = new Map<
    string,
    { key: string; storedValue: string; valueIv: string | null; isSecret: boolean }
  >();
  for (const scope of scopes) {
    if (!scope.value) continue;
    const rows = await db
      .select({
        key: scope.table.envKey,
        storedValue: scope.table.storedValue,
        valueIv: scope.table.valueIv,
        isSecret: scope.table.isSecret,
      })
      .from(scope.table)
      .where(eq(scope.id, scope.value));
    for (const row of rows) merged.set(row.key, row);
  }
  for (const name of secretNames) {
    if (!merged.get(name)?.isSecret)
      throw errors.badRequest('Selected name is not a managed secret');
  }
  return {
    context,
    envVars: await resolveRuntimeEnvRows([...merged.values()], encryptionKey, new Set(secretNames)),
  };
}
