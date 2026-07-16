import type { WorkspaceRuntimeAssetsResponse } from '@simple-agent-manager/shared';
import { and, eq } from 'drizzle-orm';
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
        eq(schema.agentProfiles.projectId, workspace.projectId)
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
    .where(
      and(
        eq(schema.skills.id, skillId),
        eq(schema.skills.projectId, workspace.projectId)
      )
    )
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

export async function resolveWorkspaceRuntimeAssetContext(
  db: Db,
  input: RuntimeAssetContextInput
): Promise<RuntimeAssetContext> {
  const workspace = await getWorkspaceRuntimeBase(db, input.workspaceId);
  if (!workspace.projectId) {
    return {
      workspaceId: workspace.id,
      projectId: null,
      userId: workspace.userId,
      agentProfileId: null,
      skillId: null,
      source: 'none',
    };
  }

  let runtimeIds: { profileId: string | null; skillId: string | null } = {
    profileId: null,
    skillId: null,
  };
  let source: RuntimeAssetContext['source'] = 'none';

  const agentSessionId = input.agentSessionId?.trim();
  if (agentSessionId) {
    runtimeIds = await resolveAgentSessionRuntimeIds(db, workspace, agentSessionId);
    source = 'agent-session';
  } else {
    const taskIds = await resolveTaskRuntimeIds(db, workspace);
    if (taskIds.profileId || taskIds.skillId) {
      runtimeIds = taskIds;
      source = 'task';
    } else if (workspace.agentProfileHint) {
      runtimeIds = { profileId: workspace.agentProfileHint, skillId: null };
      source = 'workspace';
    }
  }

  const [agentProfileId, skillId] = await Promise.all([
    validateProfileId(db, workspace, runtimeIds.profileId),
    validateSkillId(db, workspace, runtimeIds.skillId),
  ]);

  return {
    workspaceId: workspace.id,
    projectId: workspace.projectId,
    userId: workspace.userId,
    agentProfileId,
    skillId,
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

  return {
    workspaceId: workspace.id,
    envVars: mergedAssets.envVars,
    files: mergedAssets.files,
  };
}
