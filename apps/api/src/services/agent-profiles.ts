import type {
  AgentProfile,
  CreateAgentProfileRequest,
  GitHubCliPolicy,
  ResolvedAgentProfile,
  UpdateAgentProfileRequest,
} from '@simple-agent-manager/shared';
import { isValidAgentType } from '@simple-agent-manager/shared';
import { and, eq, isNull, or } from 'drizzle-orm';
import { type drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { ulid } from '../lib/ulid';
import { errors } from '../middleware/error';

type Db = ReturnType<typeof drizzle<typeof schema>>;

/** Env vars used by agent profile service */
type ProfileEnv = Pick<Env, 'DEFAULT_TASK_AGENT_TYPE'>;

function parseGitHubCliPolicy(raw: string | null): GitHubCliPolicy | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as GitHubCliPolicy;
    if (
      parsed &&
      (parsed.mode === 'inherit' || parsed.mode === 'custom') &&
      parsed.repositoryScope === 'project' &&
      parsed.permissions &&
      (parsed.permissions.contents === 'read' || parsed.permissions.contents === 'write')
    ) {
      return parsed;
    }
  } catch {
    return null;
  }
  return null;
}

function serializeGitHubCliPolicy(policy: GitHubCliPolicy | null | undefined): string | null {
  if (!policy || policy.mode === 'inherit') return null;
  return JSON.stringify(policy);
}

/** Convert a DB row to an API response */
function toAgentProfile(row: schema.AgentProfileRow): AgentProfile {
  return {
    id: row.id,
    projectId: row.projectId,
    userId: row.userId,
    name: row.name,
    description: row.description,
    agentType: row.agentType,
    model: row.model,
    permissionMode: row.permissionMode,
    systemPromptAppend: row.systemPromptAppend,
    maxTurns: row.maxTurns,
    timeoutMinutes: row.timeoutMinutes,
    vmSizeOverride: row.vmSizeOverride,
    provider: row.provider,
    vmLocation: row.vmLocation,
    workspaceProfile: row.workspaceProfile,
    devcontainerConfigName: row.devcontainerConfigName,
    taskMode: row.taskMode,
    githubCliPolicy: parseGitHubCliPolicy(row.githubCliPolicy),
    isBuiltin: row.isBuiltin === 1,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * List all profiles for a project (project-scoped + global).
 */
export async function listProfiles(
  db: Db,
  projectId: string,
  userId: string,
  _env: ProfileEnv
): Promise<AgentProfile[]> {
  const rows = await db
    .select()
    .from(schema.agentProfiles)
    .where(
      or(
        eq(schema.agentProfiles.projectId, projectId),
        and(isNull(schema.agentProfiles.projectId), eq(schema.agentProfiles.userId, userId))
      )
    )
    .orderBy(schema.agentProfiles.name);

  return rows.map(toAgentProfile);
}

/** Get a single profile by ID, verifying project + user access */
export async function getProfile(
  db: Db,
  projectId: string,
  profileId: string,
  userId: string
): Promise<AgentProfile> {
  const rows = await db
    .select()
    .from(schema.agentProfiles)
    .where(
      and(
        eq(schema.agentProfiles.id, profileId),
        or(
          eq(schema.agentProfiles.projectId, projectId),
          and(isNull(schema.agentProfiles.projectId), eq(schema.agentProfiles.userId, userId))
        )
      )
    )
    .limit(1);

  const row = rows[0];
  if (!row) {
    throw errors.notFound('Agent profile');
  }

  return toAgentProfile(row);
}

/** Create a new profile scoped to a project */
export async function createProfile(
  db: Db,
  projectId: string,
  userId: string,
  body: CreateAgentProfileRequest,
  env: Pick<Env, 'DEFAULT_TASK_AGENT_TYPE'>
): Promise<AgentProfile> {
  const name = body.name?.trim();
  if (!name) {
    throw errors.badRequest('name is required');
  }

  if (body.agentType && !isValidAgentType(body.agentType)) {
    throw errors.badRequest(`Invalid agent type: ${body.agentType}`);
  }

  // Check for duplicate name in this project
  const existing = await db
    .select({ id: schema.agentProfiles.id })
    .from(schema.agentProfiles)
    .where(and(eq(schema.agentProfiles.projectId, projectId), eq(schema.agentProfiles.name, name)))
    .limit(1);

  if (existing.length > 0) {
    throw errors.conflict(`Profile "${name}" already exists in this project`);
  }

  const id = ulid();
  await db.insert(schema.agentProfiles).values({
    id,
    projectId,
    userId,
    name,
    description: body.description ?? null,
    agentType: body.agentType ?? env.DEFAULT_TASK_AGENT_TYPE ?? 'opencode',
    model: body.model ?? null,
    permissionMode: body.permissionMode ?? null,
    systemPromptAppend: body.systemPromptAppend ?? null,
    maxTurns: body.maxTurns ?? null,
    timeoutMinutes: body.timeoutMinutes ?? null,
    vmSizeOverride: body.vmSizeOverride ?? null,
    provider: body.provider ?? null,
    vmLocation: body.vmLocation ?? null,
    workspaceProfile: body.workspaceProfile ?? null,
    devcontainerConfigName: body.devcontainerConfigName ?? null,
    taskMode: body.taskMode ?? null,
    githubCliPolicy: serializeGitHubCliPolicy(body.githubCliPolicy),
    isBuiltin: 0,
  });

  return getProfile(db, projectId, id, userId);
}

/** Update an existing profile */
export async function updateProfile(
  db: Db,
  projectId: string,
  profileId: string,
  userId: string,
  body: UpdateAgentProfileRequest
): Promise<AgentProfile> {
  // Verify profile exists and user has access
  const profile = await getProfile(db, projectId, profileId, userId);

  if (body.agentType && !isValidAgentType(body.agentType)) {
    throw errors.badRequest(`Invalid agent type: ${body.agentType}`);
  }

  // If renaming, check for duplicate in the same project scope
  if (body.name !== undefined) {
    const name = body.name.trim();
    if (!name) {
      throw errors.badRequest('name cannot be empty');
    }

    if (name !== profile.name) {
      const existing = await db
        .select({ id: schema.agentProfiles.id })
        .from(schema.agentProfiles)
        .where(
          and(eq(schema.agentProfiles.projectId, projectId), eq(schema.agentProfiles.name, name))
        )
        .limit(1);

      if (existing.length > 0) {
        throw errors.conflict(`Profile "${name}" already exists in this project`);
      }
    }
  }

  const updates: Partial<schema.NewAgentProfileRow> = {
    updatedAt: new Date().toISOString(),
  };

  if (body.name !== undefined) updates.name = body.name.trim();
  if (body.description !== undefined) updates.description = body.description;
  if (body.agentType !== undefined) updates.agentType = body.agentType;
  if (body.model !== undefined) updates.model = body.model;
  if (body.permissionMode !== undefined) updates.permissionMode = body.permissionMode;
  if (body.systemPromptAppend !== undefined) updates.systemPromptAppend = body.systemPromptAppend;
  if (body.maxTurns !== undefined) updates.maxTurns = body.maxTurns;
  if (body.timeoutMinutes !== undefined) updates.timeoutMinutes = body.timeoutMinutes;
  if (body.vmSizeOverride !== undefined) updates.vmSizeOverride = body.vmSizeOverride;
  if (body.provider !== undefined) updates.provider = body.provider;
  if (body.vmLocation !== undefined) updates.vmLocation = body.vmLocation;
  if (body.workspaceProfile !== undefined) updates.workspaceProfile = body.workspaceProfile;
  if (body.devcontainerConfigName !== undefined)
    updates.devcontainerConfigName = body.devcontainerConfigName;
  if (body.taskMode !== undefined) updates.taskMode = body.taskMode;
  if (body.githubCliPolicy !== undefined)
    updates.githubCliPolicy = serializeGitHubCliPolicy(body.githubCliPolicy);

  await db
    .update(schema.agentProfiles)
    .set(updates)
    .where(
      and(eq(schema.agentProfiles.id, profileId), eq(schema.agentProfiles.projectId, projectId))
    );

  return getProfile(db, projectId, profileId, userId);
}

/** Delete a profile */
export async function deleteProfile(
  db: Db,
  projectId: string,
  profileId: string,
  userId: string
): Promise<void> {
  // Verify it exists and user has access
  await getProfile(db, projectId, profileId, userId);

  await db
    .delete(schema.agentProfiles)
    .where(
      and(eq(schema.agentProfiles.id, profileId), eq(schema.agentProfiles.projectId, projectId))
    );
}

/**
 * Resolve an agent profile by name or ID for a given project.
 * Resolution order:
 *   1. Exact match by ID in project scope
 *   2. Exact match by name in project scope
 *   3. Exact match by name in global scope (user's profiles with project_id = NULL)
 *   4. Fallback to platform defaults
 */
export async function resolveAgentProfile(
  db: Db,
  projectId: string,
  profileNameOrId: string | null | undefined,
  userId: string,
  env: ProfileEnv
): Promise<ResolvedAgentProfile> {
  // Helper to convert a DB row into a ResolvedAgentProfile
  function rowToResolved(p: schema.AgentProfileRow): ResolvedAgentProfile {
    return {
      profileId: p.id,
      profileName: p.name,
      agentType: p.agentType,
      model: p.model,
      permissionMode: p.permissionMode,
      systemPromptAppend: p.systemPromptAppend,
      maxTurns: p.maxTurns,
      timeoutMinutes: p.timeoutMinutes,
      vmSizeOverride: p.vmSizeOverride,
      provider: p.provider,
      vmLocation: p.vmLocation,
      workspaceProfile: p.workspaceProfile,
      devcontainerConfigName: p.devcontainerConfigName,
      taskMode: p.taskMode,
      githubCliPolicy: parseGitHubCliPolicy(p.githubCliPolicy),
    };
  }

  // No profile hint → return platform defaults
  if (!profileNameOrId) {
    return {
      profileId: null,
      profileName: null,
      agentType: env.DEFAULT_TASK_AGENT_TYPE || 'opencode',
      model: null,
      permissionMode: null,
      systemPromptAppend: null,
      maxTurns: null,
      timeoutMinutes: null,
      vmSizeOverride: null,
      provider: null,
      vmLocation: null,
      workspaceProfile: null,
      devcontainerConfigName: null,
      taskMode: null,
      githubCliPolicy: null,
    };
  }

  // Try by ID first
  const byId = await db
    .select()
    .from(schema.agentProfiles)
    .where(
      and(
        eq(schema.agentProfiles.id, profileNameOrId),
        or(
          eq(schema.agentProfiles.projectId, projectId),
          and(isNull(schema.agentProfiles.projectId), eq(schema.agentProfiles.userId, userId))
        )
      )
    )
    .limit(1);

  if (byId[0]) {
    return rowToResolved(byId[0]);
  }

  // Try by name in project scope
  const byNameProject = await db
    .select()
    .from(schema.agentProfiles)
    .where(
      and(
        eq(schema.agentProfiles.name, profileNameOrId),
        eq(schema.agentProfiles.projectId, projectId)
      )
    )
    .limit(1);

  if (byNameProject[0]) {
    return rowToResolved(byNameProject[0]);
  }

  // Try by name in global scope (user's profiles with no project)
  const byNameGlobal = await db
    .select()
    .from(schema.agentProfiles)
    .where(
      and(
        eq(schema.agentProfiles.name, profileNameOrId),
        isNull(schema.agentProfiles.projectId),
        eq(schema.agentProfiles.userId, userId)
      )
    )
    .limit(1);

  if (byNameGlobal[0]) {
    return rowToResolved(byNameGlobal[0]);
  }

  // No matching profile found — return defaults with the hint as agent type if valid
  const agentType = isValidAgentType(profileNameOrId)
    ? profileNameOrId
    : env.DEFAULT_TASK_AGENT_TYPE || 'opencode';

  return {
    profileId: null,
    profileName: null,
    agentType,
    model: null,
    permissionMode: null,
    systemPromptAppend: null,
    maxTurns: null,
    timeoutMinutes: null,
    vmSizeOverride: null,
    provider: null,
    vmLocation: null,
    workspaceProfile: null,
    devcontainerConfigName: null,
    taskMode: null,
    githubCliPolicy: null,
  };
}
