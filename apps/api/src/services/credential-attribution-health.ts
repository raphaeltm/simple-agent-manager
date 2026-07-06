import type {
  CredentialAttributionCheck,
  CredentialAttributionResource,
  CredentialAttributionUser,
  ProjectCredentialAttributionHealthSummary,
} from '@simple-agent-manager/shared';
import { and, eq, inArray, isNull, or } from 'drizzle-orm';

import * as schema from '../db/schema';
import type { AppDb } from '../middleware/project-auth';
import { getProjectMultiplayerState } from './project-multiplayer';

type ProjectRow = Pick<
  schema.Project,
  'id' | 'defaultAgentType' | 'defaultProvider'
>;

type TriggerWithProfile = schema.TriggerRow & {
  profileAgentType: string | null;
  profileProvider: string | null;
};

const INHERITED_COMPUTE_TARGET = 'inherited-provider';

interface ProjectAttachmentCoverage {
  configurationId: string;
  configurationName: string;
  credentialId: string | null;
  credentialName: string | null;
  ownerId: string | null;
}

function userMeta(row: {
  id: string;
  name: string | null;
  email: string | null;
  avatarUrl: string | null;
} | null | undefined): CredentialAttributionUser | null {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    avatarUrl: row.avatarUrl,
  };
}

function displayName(user: CredentialAttributionUser | null): string {
  return user?.name || user?.email || 'this member';
}

function coverageKey(kind: string, target: string): string {
  return `${kind}:${target}`;
}

function findCoverage(
  coverage: Map<string, ProjectAttachmentCoverage>,
  kind: 'agent' | 'compute',
  target: string
): ProjectAttachmentCoverage | null {
  const exact = coverage.get(coverageKey(kind, target));
  if (exact) return exact;

  if (kind !== 'compute' || target !== INHERITED_COMPUTE_TARGET) return null;

  const computeCoverage = Array.from(coverage.entries())
    .filter(([key]) => key.startsWith('compute:'))
    .map(([, item]) => item);
  return computeCoverage.length === 1 ? computeCoverage[0] ?? null : null;
}

function resourceHasPersonalWarning(resource: CredentialAttributionResource): boolean {
  return resource.checks.some((check) => check.source === 'personal');
}

function buildCheck(input: {
  consumerKind: 'agent' | 'compute';
  consumerTarget: string;
  label: string;
  owner: CredentialAttributionUser | null;
  coverage: ProjectAttachmentCoverage | null;
  coverageOwner: CredentialAttributionUser | null;
  fixHref: string;
}): CredentialAttributionCheck {
  if (input.coverage) {
    return {
      consumerKind: input.consumerKind,
      consumerTarget: input.consumerTarget,
      label: input.label,
      source: 'project',
      owner: input.coverageOwner,
      projectCredential: {
        configurationId: input.coverage.configurationId,
        configurationName: input.coverage.configurationName,
        credentialId: input.coverage.credentialId,
        credentialName: input.coverage.credentialName,
        owner: input.coverageOwner,
      },
      fixHref: input.fixHref,
      warning: null,
    };
  }

  const ownerName = displayName(input.owner);
  return {
    consumerKind: input.consumerKind,
    consumerTarget: input.consumerTarget,
    label: input.label,
    source: 'personal',
    owner: input.owner,
    projectCredential: null,
    fixHref: input.fixHref,
    warning: `This runs on ${ownerName}'s personal key.`,
  };
}

async function loadProjectAttachmentCoverage(
  db: AppDb,
  projectId: string
): Promise<Map<string, ProjectAttachmentCoverage>> {
  const rows = await db
    .select({
      consumerKind: schema.ccAttachments.consumerKind,
      consumerTarget: schema.ccAttachments.consumerTarget,
      configurationId: schema.ccConfigurations.id,
      configurationName: schema.ccConfigurations.name,
      credentialId: schema.ccConfigurations.credentialId,
      credentialName: schema.ccCredentials.name,
      ownerId: schema.ccCredentials.ownerId,
    })
    .from(schema.ccAttachments)
    .innerJoin(
      schema.ccConfigurations,
      eq(schema.ccAttachments.configurationId, schema.ccConfigurations.id)
    )
    .leftJoin(schema.ccCredentials, eq(schema.ccConfigurations.credentialId, schema.ccCredentials.id))
    .where(
      and(
        eq(schema.ccAttachments.projectId, projectId),
        eq(schema.ccAttachments.isActive, true),
        eq(schema.ccConfigurations.isActive, true),
        or(eq(schema.ccCredentials.isActive, true), isNull(schema.ccConfigurations.credentialId))
      )
    );

  const coverage = new Map<string, ProjectAttachmentCoverage>();
  for (const row of rows) {
    coverage.set(coverageKey(row.consumerKind, row.consumerTarget), {
      configurationId: row.configurationId,
      configurationName: row.configurationName,
      credentialId: row.credentialId,
      credentialName: row.credentialName,
      ownerId: row.ownerId,
    });
  }
  return coverage;
}

async function loadUsers(db: AppDb, userIds: string[]): Promise<Map<string, CredentialAttributionUser>> {
  const uniqueIds = Array.from(new Set(userIds.filter(Boolean)));
  if (uniqueIds.length === 0) return new Map();

  const rows = await db
    .select({
      id: schema.users.id,
      name: schema.users.name,
      email: schema.users.email,
      avatarUrl: schema.users.avatarUrl,
    })
    .from(schema.users)
    .where(inArray(schema.users.id, uniqueIds));

  const users = new Map<string, CredentialAttributionUser>();
  for (const row of rows) {
    const meta = userMeta(row);
    if (meta) users.set(row.id, meta);
  }
  return users;
}

function inferAgentTarget(
  trigger: TriggerWithProfile,
  project: ProjectRow,
  defaultAgentType: string
): string {
  return trigger.profileAgentType ?? project.defaultAgentType ?? defaultAgentType;
}

function inferComputeTarget(trigger: TriggerWithProfile, project: ProjectRow): string {
  return trigger.profileProvider ?? project.defaultProvider ?? INHERITED_COMPUTE_TARGET;
}

export async function buildCredentialAttributionForTriggers(input: {
  db: AppDb;
  project: ProjectRow;
  triggers: schema.TriggerRow[];
  defaultAgentType: string;
}): Promise<Map<string, CredentialAttributionCheck[]>> {
  const { db, project, defaultAgentType } = input;
  if (input.triggers.length === 0) return new Map();

  const profileIds = input.triggers
    .map((trigger) => trigger.agentProfileId)
    .filter((id): id is string => Boolean(id));
  const profiles = profileIds.length
    ? await db
        .select({
          id: schema.agentProfiles.id,
          agentType: schema.agentProfiles.agentType,
          provider: schema.agentProfiles.provider,
        })
        .from(schema.agentProfiles)
        .where(inArray(schema.agentProfiles.id, profileIds))
    : [];
  const profileById = new Map(profiles.map((profile) => [profile.id, profile]));

  const triggersWithProfile: TriggerWithProfile[] = input.triggers.map((trigger) => {
    const profile = trigger.agentProfileId ? profileById.get(trigger.agentProfileId) : null;
    return {
      ...trigger,
      profileAgentType: profile?.agentType ?? null,
      profileProvider: profile?.provider ?? null,
    };
  });

  const coverage = await loadProjectAttachmentCoverage(db, project.id);
  const coverageOwnerIds = Array.from(coverage.values())
    .map((item) => item.ownerId)
    .filter((id): id is string => Boolean(id));
  const triggerOwnerIds = triggersWithProfile.map((trigger) => trigger.userId);
  const users = await loadUsers(db, [...triggerOwnerIds, ...coverageOwnerIds]);

  const checksByTriggerId = new Map<string, CredentialAttributionCheck[]>();
  for (const trigger of triggersWithProfile) {
    const owner = users.get(trigger.userId) ?? null;
    const agentTarget = inferAgentTarget(trigger, project, defaultAgentType);
    const computeTarget = inferComputeTarget(trigger, project);
    const fixHref = `/projects/${project.id}/settings/connections`;
    const agentCoverage = findCoverage(coverage, 'agent', agentTarget);
    const computeCoverage = findCoverage(coverage, 'compute', computeTarget);

    checksByTriggerId.set(trigger.id, [
      buildCheck({
        consumerKind: 'agent',
        consumerTarget: agentTarget,
        label: `Agent credential (${agentTarget})`,
        owner,
        coverage: agentCoverage,
        coverageOwner: agentCoverage?.ownerId ? users.get(agentCoverage.ownerId) ?? null : null,
        fixHref,
      }),
      buildCheck({
        consumerKind: 'compute',
        consumerTarget: computeTarget,
        label: `Compute credential (${computeTarget})`,
        owner,
        coverage: computeCoverage,
        coverageOwner: computeCoverage?.ownerId ? users.get(computeCoverage.ownerId) ?? null : null,
        fixHref,
      }),
    ]);
  }

  return checksByTriggerId;
}

export async function getProjectCredentialAttributionHealth(input: {
  db: AppDb;
  project: ProjectRow;
  defaultAgentType: string;
  multiplayerActive?: boolean;
}): Promise<ProjectCredentialAttributionHealthSummary> {
  const { db, project, defaultAgentType } = input;
  const multiplayerActive = input.multiplayerActive
    ?? (await getProjectMultiplayerState(db, project.id)).multiplayerActive;
  const triggerRows = await db
    .select()
    .from(schema.triggers)
    .where(eq(schema.triggers.projectId, project.id));
  const checksByTriggerId = await buildCredentialAttributionForTriggers({
    db,
    project,
    triggers: triggerRows,
    defaultAgentType,
  });

  const resources: CredentialAttributionResource[] = triggerRows.map((trigger) => {
    const checks = checksByTriggerId.get(trigger.id) ?? [];
    const createdBy = checks[0]?.owner ?? null;
    return {
      id: trigger.id,
      projectId: project.id,
      kind: 'trigger',
      title: trigger.name,
      subtitle: trigger.sourceType === 'cron'
        ? trigger.cronExpression
        : trigger.sourceType,
      href: `/projects/${project.id}/triggers/${trigger.id}`,
      createdBy,
      checks,
    };
  });

  return {
    projectId: project.id,
    multiplayerActive,
    counts: {
      resources: resources.length,
      personalResources: resources.filter(resourceHasPersonalWarning).length,
      personalCredentials: resources.reduce(
        (total, resource) =>
          total + resource.checks.filter((check) => check.source === 'personal').length,
        0
      ),
      projectCoveredCredentials: resources.reduce(
        (total, resource) =>
          total + resource.checks.filter((check) => check.source === 'project').length,
        0
      ),
      unknownCredentials: resources.reduce(
        (total, resource) =>
          total + resource.checks.filter((check) => check.source === 'unknown').length,
        0
      ),
    },
    resources,
  };
}
