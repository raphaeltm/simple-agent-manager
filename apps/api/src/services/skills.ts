import type {
  AgentSkill,
  CreateSkillRequest,
  ResolvedSkillProfile,
  UpdateSkillRequest,
} from '@simple-agent-manager/shared';
import { isValidAgentType } from '@simple-agent-manager/shared';
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

type Db = ReturnType<typeof drizzle<typeof schema>>;

type SkillEnv = Pick<Env, 'DEFAULT_TASK_AGENT_TYPE'>;

function toSkill(row: schema.SkillRow): AgentSkill {
  return {
    ...toBaseProfileFields(row),
    githubCliPolicy: null,
    resourceRequirementsJson: row.resourceRequirementsJson,
    defaultProfileId: row.defaultProfileId,
  };
}

function validateResourceRequirementsJson(value: string | null | undefined): string | null {
  if (value == null || value.trim() === '') return null;
  try {
    const parsed = JSON.parse(value);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('resourceRequirementsJson must be a JSON object');
    }
    return JSON.stringify(parsed);
  } catch {
    throw errors.badRequest('resourceRequirementsJson must be a valid JSON object');
  }
}

export function parseSkillResourceRequirementsJson(value: string | null | undefined): Record<string, unknown> | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return undefined;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
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

export async function createSkill(
  db: Db,
  projectId: string,
  userId: string,
  body: CreateSkillRequest,
  env: Pick<Env, 'DEFAULT_TASK_AGENT_TYPE'>
): Promise<AgentSkill> {
  const name = body.name?.trim();
  if (!name) throw errors.badRequest('name is required');
  if (body.agentType && !isValidAgentType(body.agentType)) {
    throw errors.badRequest(`Invalid agent type: ${body.agentType}`);
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
    taskMode: body.taskMode ?? 'task',
    resourceRequirementsJson: validateResourceRequirementsJson(body.resourceRequirementsJson),
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
  if (skill.isBuiltin) throw errors.forbidden('Builtin skills cannot be modified');
  if (body.agentType && !isValidAgentType(body.agentType)) {
    throw errors.badRequest(`Invalid agent type: ${body.agentType}`);
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
  applyBaseProfileUpdates(updates, body);
  if (body.resourceRequirementsJson !== undefined) {
    updates.resourceRequirementsJson = validateResourceRequirementsJson(body.resourceRequirementsJson);
  }
  if (body.defaultProfileId !== undefined) {
    updates.defaultProfileId = await requireProjectProfile(db, projectId, body.defaultProfileId, userId);
  }

  await db
    .update(schema.skills)
    .set(updates)
    .where(and(eq(schema.skills.id, skillId), eq(schema.skills.projectId, projectId)));

  return getSkill(db, projectId, skillId, userId);
}

export async function deleteSkill(db: Db, projectId: string, skillId: string, userId: string): Promise<void> {
  const skill = await getSkill(db, projectId, skillId, userId);
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
  env: SkillEnv
): Promise<ResolvedSkillProfile> {
  let skill: schema.SkillRow | null = null;
  if (skillNameOrId) {
    const byId = await db
      .select()
      .from(schema.skills)
      .where(
        and(
          eq(schema.skills.id, skillNameOrId),
          or(eq(schema.skills.projectId, projectId), and(isNull(schema.skills.projectId), eq(schema.skills.userId, userId)))
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
    env
  );
  const promptAppend = [profile.systemPromptAppend, skill?.systemPromptAppend]
    .filter((value): value is string => Boolean(value?.trim()))
    .join('\n\n') || null;

  return {
    ...profile,
    skillId: skill?.id ?? null,
    skillName: skill?.name ?? null,
    skillHint: skillNameOrId ?? null,
    agentType: skill?.agentType ?? profile.agentType,
    model: skill?.model ?? profile.model,
    permissionMode: skill?.permissionMode ?? profile.permissionMode,
    systemPromptAppend: promptAppend,
    maxTurns: skill?.maxTurns ?? profile.maxTurns,
    timeoutMinutes: skill?.timeoutMinutes ?? profile.timeoutMinutes,
    vmSizeOverride: skill?.vmSizeOverride ?? profile.vmSizeOverride,
    provider: skill?.provider ?? profile.provider,
    vmLocation: skill?.vmLocation ?? profile.vmLocation,
    workspaceProfile: skill?.workspaceProfile ?? profile.workspaceProfile,
    devcontainerConfigName: skill?.devcontainerConfigName ?? profile.devcontainerConfigName,
    taskMode: skill?.taskMode ?? profile.taskMode,
    resourceRequirementsJson: skill?.resourceRequirementsJson ?? null,
    defaultProfileId: skill?.defaultProfileId ?? null,
  };
}
