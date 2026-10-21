import type {
  AgentEffort,
  AgentSkill,
  CreateSkillRequest,
  ResolvedSkillProfile,
  ResourceRequirements,
  UpdateSkillRequest,
} from '@simple-agent-manager/shared';
import {
  isAgentEffort,
  isAgentEffortSupported,
  isAgentProfileRuntime,
  isValidAgentType,
} from '@simple-agent-manager/shared';
import { and, eq, isNull, or } from 'drizzle-orm';
import { type drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { ulid } from '../lib/ulid';
import { errors } from '../middleware/error';
import { resolveAgentProfile } from './agent-profiles';
import {
  applyBaseProfileUpdates,
  baseProfileInsertValues,
  toBaseProfileFields,
} from './profile-fields';
import {
  parseStoredResourceRequirementsJson,
  ResourceRequirementsValidationError,
  serializeResourceRequirementsInput,
} from './resource-requirements-input';

type Db = ReturnType<typeof drizzle<typeof schema>>;

type SkillEnv = Pick<Env, 'DEFAULT_TASK_AGENT_TYPE'>;

function toSkill(row: schema.SkillRow): AgentSkill {
  return {
    ...toBaseProfileFields(row),
    effort: isAgentEffort(row.effort) ? row.effort : null,
    githubCliPolicy: null,
    resourceRequirementsJson: row.resourceRequirementsJson,
    defaultProfileId: row.defaultProfileId,
  };
}

function serializeSkillResourceRequirements(body: {
  resourceRequirements?: unknown;
  resourceRequirementsJson?: string | null;
}): string | null {
  try {
    if (body.resourceRequirements !== undefined) {
      return serializeResourceRequirementsInput(body.resourceRequirements);
    }
    if (body.resourceRequirementsJson !== undefined) {
      return serializeResourceRequirementsInput(
        body.resourceRequirementsJson,
        'resourceRequirementsJson'
      );
    }
    return null;
  } catch (err) {
    if (err instanceof ResourceRequirementsValidationError) {
      throw errors.badRequest(err.message);
    }
    throw err;
  }
}

export function parseSkillResourceRequirementsJson(
  value: string | null | undefined
): ResourceRequirements | undefined {
  return parseStoredResourceRequirementsJson(value);
}

async function requireProjectProfile(
  db: Db,
  projectId: string,
  profileId: string | null | undefined,
  userId: string
): Promise<string | null> {
  if (!profileId) return null;

  const rows = await db
    .select({ id: schema.agentProfiles.id })
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

  if (!rows[0]) {
    throw errors.badRequest('defaultProfileId must reference an accessible agent profile');
  }
  return rows[0].id;
}

export async function listSkills(db: Db, projectId: string, userId: string): Promise<AgentSkill[]> {
  const rows = await db
    .select()
    .from(schema.skills)
    .where(
      or(
        eq(schema.skills.projectId, projectId),
        and(isNull(schema.skills.projectId), eq(schema.skills.userId, userId))
      )
    )
    .orderBy(schema.skills.name);

  return rows.map(toSkill);
}

export async function getSkill(
  db: Db,
  projectId: string,
  skillId: string,
  userId: string
): Promise<AgentSkill> {
  const rows = await db
    .select()
    .from(schema.skills)
    .where(
      and(
        eq(schema.skills.id, skillId),
        or(
          eq(schema.skills.projectId, projectId),
          and(isNull(schema.skills.projectId), eq(schema.skills.userId, userId))
        )
      )
    )
    .limit(1);

  const row = rows[0];
  if (!row) throw errors.notFound('Skill');
  return toSkill(row);
}

/**
 * A skill's agent override as stored: null leaves the agent to the chosen profile. An
 * empty string means the same thing; clients whose tool schema types the field as a
 * plain string send it to clear the override.
 */
function normalizeSkillAgentType(value: string | null | undefined): string | null | undefined {
  if (value === undefined || value === null) return value;
  return value.trim() || null;
}

export async function createSkill(
  db: Db,
  projectId: string,
  userId: string,
  body: CreateSkillRequest,
  env: Pick<Env, 'DEFAULT_TASK_AGENT_TYPE'>
): Promise<AgentSkill> {
  const name = body.name?.trim();
  if (!name) throw errors.badRequest('name is required');
  // A skill only overrides what it sets: without an agent type the run uses the
  // chosen profile's agent, so effort support is checked when the skill is resolved.
  const createAgentType = normalizeSkillAgentType(body.agentType) ?? null;
  if (createAgentType && !isValidAgentType(createAgentType)) {
    throw errors.badRequest(`Invalid agent type: ${createAgentType}`);
  }
  if (body.effort && createAgentType && !isAgentEffortSupported(createAgentType, body.effort)) {
    throw errors.badRequest(
      `Effort '${body.effort}' is not supported for agent type '${createAgentType}'`
    );
  }

  const existing = await db
    .select({ id: schema.skills.id })
    .from(schema.skills)
    .where(and(eq(schema.skills.projectId, projectId), eq(schema.skills.name, name)))
    .limit(1);
  if (existing[0]) throw errors.conflict(`Skill "${name}" already exists in this project`);

  const id = ulid();
  await db.insert(schema.skills).values({
    id,
    projectId,
    userId,
    name,
    ...baseProfileInsertValues(body, env),
    // Never stamp the platform default agent on a skill (it would override the profile).
    agentType: createAgentType,
    effort: body.effort ?? null,
    taskMode: body.taskMode ?? 'task',
    resourceRequirementsJson: serializeSkillResourceRequirements(body),
    defaultProfileId: await requireProjectProfile(db, projectId, body.defaultProfileId, userId),
    isBuiltin: 0,
  });

  return getSkill(db, projectId, id, userId);
}

export async function updateSkill(
  db: Db,
  projectId: string,
  skillId: string,
  userId: string,
  body: UpdateSkillRequest
): Promise<AgentSkill> {
  const skill = await getSkill(db, projectId, skillId, userId);
  if (skill.projectId !== projectId)
    throw errors.badRequest('Global skills must be edited through their own scope');
  if (skill.isBuiltin) throw errors.forbidden('Builtin skills cannot be modified');
  const requestedAgentType = normalizeSkillAgentType(body.agentType);
  if (requestedAgentType && !isValidAgentType(requestedAgentType)) {
    throw errors.badRequest(`Invalid agent type: ${requestedAgentType}`);
  }
  const updateAgentType = requestedAgentType !== undefined ? requestedAgentType : skill.agentType;
  if (body.effort && updateAgentType && !isAgentEffortSupported(updateAgentType, body.effort)) {
    throw errors.badRequest(
      `Effort '${body.effort}' is not supported for agent type '${updateAgentType}'`
    );
  }

  if (body.name !== undefined) {
    const name = body.name.trim();
    if (!name) throw errors.badRequest('name cannot be empty');
    if (name !== skill.name) {
      const existing = await db
        .select({ id: schema.skills.id })
        .from(schema.skills)
        .where(and(eq(schema.skills.projectId, projectId), eq(schema.skills.name, name)))
        .limit(1);
      if (existing[0]) throw errors.conflict(`Skill "${name}" already exists in this project`);
    }
  }

  const updates: Partial<schema.NewSkillRow> = { updatedAt: new Date().toISOString() };
  applyBaseProfileUpdates(updates, { ...body, agentType: requestedAgentType });
  if (body.effort !== undefined) {
    updates.effort = body.effort as AgentEffort | null;
  }
  if (body.resourceRequirements !== undefined || body.resourceRequirementsJson !== undefined) {
    updates.resourceRequirementsJson = serializeSkillResourceRequirements(body);
  }
  if (body.defaultProfileId !== undefined) {
    updates.defaultProfileId = await requireProjectProfile(
      db,
      projectId,
      body.defaultProfileId,
      userId
    );
  }

  await db
    .update(schema.skills)
    .set(updates)
    .where(and(eq(schema.skills.id, skillId), eq(schema.skills.projectId, projectId)));

  return getSkill(db, projectId, skillId, userId);
}

export async function deleteSkill(
  db: Db,
  projectId: string,
  skillId: string,
  userId: string
): Promise<void> {
  const skill = await getSkill(db, projectId, skillId, userId);
  if (skill.projectId !== projectId)
    throw errors.badRequest('Global skills must be edited through their own scope');
  if (skill.isBuiltin) throw errors.forbidden('Builtin skills cannot be deleted');
  await db
    .delete(schema.skills)
    .where(and(eq(schema.skills.id, skillId), eq(schema.skills.projectId, projectId)));
}

export async function resolveSkillProfile(
  db: Db,
  projectId: string,
  profileNameOrId: string | null | undefined,
  skillNameOrId: string | null | undefined,
  userId: string,
  env: SkillEnv,
  options: { allowLegacyAgentTypeHint?: boolean } = {}
): Promise<ResolvedSkillProfile> {
  let skill: schema.SkillRow | null = null;
  if (skillNameOrId) {
    const byId = await db
      .select()
      .from(schema.skills)
      .where(
        and(
          eq(schema.skills.id, skillNameOrId),
          or(
            eq(schema.skills.projectId, projectId),
            and(isNull(schema.skills.projectId), eq(schema.skills.userId, userId))
          )
        )
      )
      .limit(1);
    skill = byId[0] ?? null;

    if (!skill) {
      const byName = await db
        .select()
        .from(schema.skills)
        .where(and(eq(schema.skills.name, skillNameOrId), eq(schema.skills.projectId, projectId)))
        .limit(1);
      skill = byName[0] ?? null;
    }
    if (!skill) throw errors.notFound('Skill');
  }

  const profile = await resolveAgentProfile(
    db,
    projectId,
    profileNameOrId ?? skill?.defaultProfileId ?? null,
    userId,
    env,
    options
  );
  const promptAppend =
    [profile.systemPromptAppend, skill?.systemPromptAppend]
      .filter((value): value is string => Boolean(value?.trim()))
      .join('\n\n') || null;
  // `||`, not `??`: a blank override stored before blanks were normalized is still unset.
  const agentType = skill?.agentType || profile.agentType;
  // A skill that sets effort but not an agent can meet a profile whose agent lacks
  // that effort level; keep the profile's effort rather than send an unsupported one.
  const requestedSkillEffort = skill?.effort ?? null;
  const skillEffort =
    isAgentEffort(requestedSkillEffort) && isAgentEffortSupported(agentType, requestedSkillEffort)
      ? requestedSkillEffort
      : null;
  const skillRuntime = skill?.runtime ?? null;

  return {
    ...profile,
    skillId: skill?.id ?? null,
    skillName: skill?.name ?? null,
    skillHint: skillNameOrId ?? null,
    agentType,
    model: skill?.model ?? profile.model,
    effort: skillEffort ?? profile.effort,
    permissionMode: skill?.permissionMode ?? profile.permissionMode,
    systemPromptAppend: promptAppend,
    maxTurns: skill?.maxTurns ?? profile.maxTurns,
    timeoutMinutes: skill?.timeoutMinutes ?? profile.timeoutMinutes,
    vmSizeOverride: skill?.vmSizeOverride ?? profile.vmSizeOverride,
    skillVmSizeOverride: skill?.vmSizeOverride ?? null,
    agentProfileVmSizeOverride: profile.vmSizeOverride ?? null,
    provider: skill?.provider ?? profile.provider,
    vmLocation: skill?.vmLocation ?? profile.vmLocation,
    workspaceProfile: skill?.workspaceProfile ?? profile.workspaceProfile,
    runtime: isAgentProfileRuntime(skillRuntime) ? skillRuntime : profile.runtime,
    devcontainerConfigName: skill?.devcontainerConfigName ?? profile.devcontainerConfigName,
    taskMode: skill?.taskMode ?? profile.taskMode,
    resourceRequirementsJson: skill
      ? (skill.resourceRequirementsJson ?? null)
      : (profile.resourceRequirementsJson ?? null),
    agentProfileResourceRequirementsJson: profile.resourceRequirementsJson ?? null,
    defaultProfileId: skill?.defaultProfileId ?? null,
  };
}
