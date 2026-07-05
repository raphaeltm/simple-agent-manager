import type {
  ProjectMemberOffboardingAction,
  ProjectMemberOffboardingCredentialSource,
  ProjectMemberOffboardingPreviewResponse,
  ProjectMemberOffboardingResourceKind,
  ProjectMemberOffboardingResourcePreview,
} from '@simple-agent-manager/shared';
import { and, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm';

import * as schema from '../db/schema';
import { ulid } from '../lib/ulid';
import { AppError, errors } from '../middleware/error';
import type { AppDb } from '../middleware/project-auth';

const OFFBOARDING_PLAN_TTL_MS = 15 * 60 * 1000;
const INHERITED_COMPUTE_TARGET = 'inherited-provider';

type CoverageKey = `${string}:${string}`;

interface RemainingAttachmentCoverage {
  consumerKind: string;
  consumerTarget: string;
  configurationId: string;
  attachmentId: string;
  ownerId: string;
}

interface ResourceDraft {
  resourceKind: ProjectMemberOffboardingResourceKind;
  resourceId: string;
  title: string;
  subtitle: string | null;
  href: string | null;
  credentialSourceBefore: ProjectMemberOffboardingCredentialSource;
  attributionUserIdBefore: string | null;
  attributionProjectIdBefore: string | null;
  recommendedAction: ProjectMemberOffboardingAction;
  availableActions: ProjectMemberOffboardingAction[];
  requiresHumanDecision: boolean;
  blocksRemoval: boolean;
  details: Record<string, unknown>;
}

function coverageKey(kind: string, target: string): CoverageKey {
  return `${kind}:${target}`;
}

function offboardingPlanId(): string {
  return `off_${ulid()}`;
}

function offboardingActionId(): string {
  return `offact_${ulid()}`;
}

function hasRemainingCoverage(
  coverage: Map<CoverageKey, RemainingAttachmentCoverage>,
  kind: 'agent' | 'compute',
  target: string
): RemainingAttachmentCoverage | null {
  const exact = coverage.get(coverageKey(kind, target));
  if (exact) return exact;

  if (kind !== 'compute' || target !== INHERITED_COMPUTE_TARGET) return null;

  const computeCoverage = Array.from(coverage.values()).filter(
    (item) => item.consumerKind === 'compute'
  );
  return computeCoverage.length === 1 ? computeCoverage[0] ?? null : null;
}

function sourceBefore(source: string | null | undefined): ProjectMemberOffboardingCredentialSource {
  if (source === 'user' || source === 'project' || source === 'platform') return source;
  return 'unknown';
}

function buildActions(hasReattach: boolean): {
  recommendedAction: ProjectMemberOffboardingAction;
  availableActions: ProjectMemberOffboardingAction[];
} {
  return {
    recommendedAction: hasReattach ? 'reattach_to_project' : 'break_and_flag',
    availableActions: hasReattach
      ? ['reattach_to_project', 'break_and_flag', 'defer_removal']
      : ['break_and_flag', 'defer_removal'],
  };
}

function summarize(resources: ResourceDraft[]): ProjectMemberOffboardingPreviewResponse['summary'] {
  return {
    breakAndFlag: resources.filter((resource) => resource.recommendedAction === 'break_and_flag')
      .length,
    reattachAvailable: resources.filter((resource) =>
      resource.availableActions.includes('reattach_to_project')
    ).length,
    blockingTeardown: resources.filter((resource) => resource.blocksRemoval).length,
  };
}

function addResource(
  resourcesByKey: Map<string, ResourceDraft>,
  draft: ResourceDraft
): void {
  resourcesByKey.set(`${draft.resourceKind}:${draft.resourceId}`, draft);
}

async function loadRemainingProjectCoverage(input: {
  db: AppDb;
  projectId: string;
  departingUserId: string;
}): Promise<Map<CoverageKey, RemainingAttachmentCoverage>> {
  const rows = await input.db
    .select({
      attachmentId: schema.ccAttachments.id,
      consumerKind: schema.ccAttachments.consumerKind,
      consumerTarget: schema.ccAttachments.consumerTarget,
      configurationId: schema.ccConfigurations.id,
      configurationOwnerId: schema.ccConfigurations.ownerId,
      credentialOwnerId: schema.ccCredentials.ownerId,
    })
    .from(schema.ccAttachments)
    .innerJoin(
      schema.ccConfigurations,
      eq(schema.ccAttachments.configurationId, schema.ccConfigurations.id)
    )
    .leftJoin(schema.ccCredentials, eq(schema.ccConfigurations.credentialId, schema.ccCredentials.id))
    .where(
      and(
        eq(schema.ccAttachments.projectId, input.projectId),
        eq(schema.ccAttachments.isActive, true),
        eq(schema.ccConfigurations.isActive, true),
        ne(schema.ccAttachments.userId, input.departingUserId),
        ne(schema.ccConfigurations.ownerId, input.departingUserId),
        or(isNull(schema.ccCredentials.ownerId), ne(schema.ccCredentials.ownerId, input.departingUserId)),
        or(eq(schema.ccCredentials.isActive, true), isNull(schema.ccConfigurations.credentialId))
      )
    );

  const coverage = new Map<CoverageKey, RemainingAttachmentCoverage>();
  for (const row of rows) {
    coverage.set(coverageKey(row.consumerKind, row.consumerTarget), {
      attachmentId: row.attachmentId,
      consumerKind: row.consumerKind,
      consumerTarget: row.consumerTarget,
      configurationId: row.configurationId,
      ownerId: row.credentialOwnerId ?? row.configurationOwnerId,
    });
  }
  return coverage;
}

async function addTriggerResources(input: {
  db: AppDb;
  project: Pick<schema.Project, 'id' | 'defaultAgentType' | 'defaultProvider'>;
  departingUserId: string;
  defaultAgentType: string;
  remainingCoverage: Map<CoverageKey, RemainingAttachmentCoverage>;
  resourcesByKey: Map<string, ResourceDraft>;
}): Promise<void> {
  const triggers = await input.db
    .select()
    .from(schema.triggers)
    .where(
      and(
        eq(schema.triggers.projectId, input.project.id),
        eq(schema.triggers.userId, input.departingUserId),
        eq(schema.triggers.status, 'active')
      )
    );
  if (triggers.length === 0) return;

  const profileIds = triggers
    .map((trigger) => trigger.agentProfileId)
    .filter((id): id is string => Boolean(id));
  const profiles = profileIds.length
    ? await input.db
        .select({
          id: schema.agentProfiles.id,
          agentType: schema.agentProfiles.agentType,
          provider: schema.agentProfiles.provider,
        })
        .from(schema.agentProfiles)
        .where(inArray(schema.agentProfiles.id, profileIds))
    : [];
  const profileById = new Map(profiles.map((profile) => [profile.id, profile]));

  for (const trigger of triggers) {
    const profile = trigger.agentProfileId ? profileById.get(trigger.agentProfileId) : null;
    const agentTarget = profile?.agentType ?? input.project.defaultAgentType ?? input.defaultAgentType;
    const computeTarget = profile?.provider ?? input.project.defaultProvider ?? INHERITED_COMPUTE_TARGET;
    const agentCoverage = hasRemainingCoverage(input.remainingCoverage, 'agent', agentTarget);
    const computeCoverage = hasRemainingCoverage(input.remainingCoverage, 'compute', computeTarget);
    const canReattach = Boolean(agentCoverage && computeCoverage);
    const actions = buildActions(canReattach);

    addResource(input.resourcesByKey, {
      resourceKind: 'trigger',
      resourceId: trigger.id,
      title: trigger.name,
      subtitle: trigger.sourceType === 'cron' ? trigger.cronExpression : trigger.sourceType,
      href: `/projects/${input.project.id}/triggers/${trigger.id}`,
      credentialSourceBefore: 'user',
      attributionUserIdBefore: trigger.userId,
      attributionProjectIdBefore: input.project.id,
      ...actions,
      requiresHumanDecision: true,
      blocksRemoval: false,
      details: {
        status: trigger.status,
        sourceType: trigger.sourceType,
        agentTarget,
        computeTarget,
        remainingProjectCoverage: {
          agent: agentCoverage
            ? { attachmentId: agentCoverage.attachmentId, configurationId: agentCoverage.configurationId }
            : null,
          compute: computeCoverage
            ? { attachmentId: computeCoverage.attachmentId, configurationId: computeCoverage.configurationId }
            : null,
        },
      },
    });
  }
}

async function addTaskResources(input: {
  db: AppDb;
  projectId: string;
  departingUserId: string;
  resourcesByKey: Map<string, ResourceDraft>;
}): Promise<void> {
  const tasks = await input.db
    .select()
    .from(schema.tasks)
    .where(
      and(
        eq(schema.tasks.projectId, input.projectId),
        eq(schema.tasks.credentialAttributionUserId, input.departingUserId),
        eq(schema.tasks.credentialAttributionSource, 'user'),
        inArray(schema.tasks.status, ['draft', 'queued', 'running'])
      )
    );

  for (const task of tasks) {
    addResource(input.resourcesByKey, {
      resourceKind: 'task_tree',
      resourceId: task.id,
      title: task.title,
      subtitle: task.status,
      href: `/projects/${input.projectId}/tasks/${task.id}`,
      credentialSourceBefore: sourceBefore(task.credentialAttributionSource),
      attributionUserIdBefore: task.credentialAttributionUserId,
      attributionProjectIdBefore: task.credentialAttributionProjectId,
      ...buildActions(false),
      requiresHumanDecision: true,
      blocksRemoval: task.status === 'running',
      details: {
        status: task.status,
        taskMode: task.taskMode,
        triggeredBy: task.triggeredBy,
        rootTaskId: task.id,
      },
    });
  }
}

async function addNodeAndDeploymentResources(input: {
  db: AppDb;
  projectId: string;
  departingUserId: string;
  remainingCoverage: Map<CoverageKey, RemainingAttachmentCoverage>;
  resourcesByKey: Map<string, ResourceDraft>;
}): Promise<void> {
  const workspaceRows = await input.db
    .select({
      workspaceId: schema.workspaces.id,
      workspaceName: schema.workspaces.name,
      node: schema.nodes,
    })
    .from(schema.workspaces)
    .innerJoin(schema.nodes, eq(schema.workspaces.nodeId, schema.nodes.id))
    .where(
      and(
        eq(schema.workspaces.projectId, input.projectId),
        eq(schema.nodes.credentialAttributionUserId, input.departingUserId),
        eq(schema.nodes.credentialAttributionSource, 'user')
      )
    );

  for (const row of workspaceRows) {
    const node = row.node;
    const provider = node.cloudProvider ?? INHERITED_COMPUTE_TARGET;
    const computeCoverage = hasRemainingCoverage(input.remainingCoverage, 'compute', provider);
    addResource(input.resourcesByKey, {
      resourceKind: 'node',
      resourceId: node.id,
      title: node.name,
      subtitle: row.workspaceName,
      href: `/projects/${input.projectId}/workspaces/${row.workspaceId}`,
      credentialSourceBefore: sourceBefore(node.credentialAttributionSource),
      attributionUserIdBefore: node.credentialAttributionUserId,
      attributionProjectIdBefore: node.credentialAttributionProjectId,
      ...buildActions(Boolean(computeCoverage)),
      requiresHumanDecision: true,
      blocksRemoval: ['active', 'pending', 'provisioning'].includes(node.status),
      details: {
        status: node.status,
        nodeRole: node.nodeRole,
        cloudProvider: node.cloudProvider,
        workspaceId: row.workspaceId,
        remainingProjectCoverage: computeCoverage
          ? { attachmentId: computeCoverage.attachmentId, configurationId: computeCoverage.configurationId }
          : null,
      },
    });
  }

  const deploymentRows = await input.db
    .select({
      environment: schema.deploymentEnvironments,
      node: schema.nodes,
    })
    .from(schema.deploymentEnvironments)
    .innerJoin(schema.nodes, eq(schema.deploymentEnvironments.nodeId, schema.nodes.id))
    .where(
      and(
        eq(schema.deploymentEnvironments.projectId, input.projectId),
        eq(schema.nodes.credentialAttributionUserId, input.departingUserId),
        eq(schema.nodes.credentialAttributionSource, 'user')
      )
    );

  for (const row of deploymentRows) {
    const provider = row.node.cloudProvider ?? INHERITED_COMPUTE_TARGET;
    const computeCoverage = hasRemainingCoverage(input.remainingCoverage, 'compute', provider);
    addResource(input.resourcesByKey, {
      resourceKind: 'deployment_environment',
      resourceId: row.environment.id,
      title: row.environment.name,
      subtitle: row.environment.status,
      href: `/projects/${input.projectId}/deployments/${row.environment.id}`,
      credentialSourceBefore: sourceBefore(row.node.credentialAttributionSource),
      attributionUserIdBefore: row.node.credentialAttributionUserId,
      attributionProjectIdBefore: row.node.credentialAttributionProjectId,
      ...buildActions(Boolean(computeCoverage)),
      requiresHumanDecision: true,
      blocksRemoval: ['active', 'starting', 'stopping'].includes(row.environment.status),
      details: {
        status: row.environment.status,
        nodeId: row.node.id,
        nodeStatus: row.node.status,
        requiresVolumes: row.environment.requiresVolumes,
        remainingProjectCoverage: computeCoverage
          ? { attachmentId: computeCoverage.attachmentId, configurationId: computeCoverage.configurationId }
          : null,
      },
    });
  }
}

async function addProjectAttachmentResources(input: {
  db: AppDb;
  projectId: string;
  departingUserId: string;
  remainingCoverage: Map<CoverageKey, RemainingAttachmentCoverage>;
  resourcesByKey: Map<string, ResourceDraft>;
}): Promise<void> {
  const rows = await input.db
    .select({
      attachment: schema.ccAttachments,
      configurationName: schema.ccConfigurations.name,
      configurationOwnerId: schema.ccConfigurations.ownerId,
      credentialOwnerId: schema.ccCredentials.ownerId,
    })
    .from(schema.ccAttachments)
    .innerJoin(
      schema.ccConfigurations,
      eq(schema.ccAttachments.configurationId, schema.ccConfigurations.id)
    )
    .leftJoin(schema.ccCredentials, eq(schema.ccConfigurations.credentialId, schema.ccCredentials.id))
    .where(
      and(
        eq(schema.ccAttachments.projectId, input.projectId),
        eq(schema.ccAttachments.isActive, true),
        or(
          eq(schema.ccAttachments.userId, input.departingUserId),
          eq(schema.ccConfigurations.ownerId, input.departingUserId),
          eq(schema.ccCredentials.ownerId, input.departingUserId)
        )
      )
    );

  for (const row of rows) {
    const attachment = row.attachment;
    const replacement = hasRemainingCoverage(
      input.remainingCoverage,
      attachment.consumerKind as 'agent' | 'compute',
      attachment.consumerTarget
    );
    addResource(input.resourcesByKey, {
      resourceKind: 'project_attachment',
      resourceId: attachment.id,
      title: row.configurationName,
      subtitle: `${attachment.consumerKind}:${attachment.consumerTarget}`,
      href: `/projects/${input.projectId}/settings`,
      credentialSourceBefore: 'project',
      attributionUserIdBefore: attachment.userId,
      attributionProjectIdBefore: input.projectId,
      ...buildActions(Boolean(replacement)),
      requiresHumanDecision: true,
      blocksRemoval: false,
      details: {
        consumerKind: attachment.consumerKind,
        consumerTarget: attachment.consumerTarget,
        attachmentUserId: attachment.userId,
        configurationOwnerId: row.configurationOwnerId,
        credentialOwnerId: row.credentialOwnerId,
        remainingProjectCoverage: replacement
          ? { attachmentId: replacement.attachmentId, configurationId: replacement.configurationId }
          : null,
      },
    });
  }
}

export async function createProjectMemberOffboardingPreview(input: {
  db: AppDb;
  project: schema.Project;
  memberUserId: string;
  requestedBy: string;
  defaultAgentType: string;
  now?: Date;
}): Promise<ProjectMemberOffboardingPreviewResponse> {
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const expiresAt = new Date(now.getTime() + OFFBOARDING_PLAN_TTL_MS).toISOString();

  const members = await input.db
    .select()
    .from(schema.projectMembers)
    .where(
      and(
        eq(schema.projectMembers.projectId, input.project.id),
        eq(schema.projectMembers.status, 'active')
      )
    );
  const targetMember = members.find((member) => member.userId === input.memberUserId);
  if (!targetMember) {
    throw errors.notFound('Project member');
  }

  const activeOwners = members.filter((member) => member.role === 'owner');
  if (targetMember.role === 'owner' && activeOwners.length <= 1) {
    throw new AppError(
      409,
      'last_owner_requires_transfer',
      'Ownership must be transferred before offboarding the sole project owner'
    );
  }

  const remainingCoverage = await loadRemainingProjectCoverage({
    db: input.db,
    projectId: input.project.id,
    departingUserId: input.memberUserId,
  });
  const resourcesByKey = new Map<string, ResourceDraft>();

  await addTriggerResources({
    db: input.db,
    project: input.project,
    departingUserId: input.memberUserId,
    defaultAgentType: input.defaultAgentType,
    remainingCoverage,
    resourcesByKey,
  });
  await addTaskResources({
    db: input.db,
    projectId: input.project.id,
    departingUserId: input.memberUserId,
    resourcesByKey,
  });
  await addNodeAndDeploymentResources({
    db: input.db,
    projectId: input.project.id,
    departingUserId: input.memberUserId,
    remainingCoverage,
    resourcesByKey,
  });
  await addProjectAttachmentResources({
    db: input.db,
    projectId: input.project.id,
    departingUserId: input.memberUserId,
    remainingCoverage,
    resourcesByKey,
  });

  const resources = Array.from(resourcesByKey.values());
  const summary = summarize(resources);
  const planId = offboardingPlanId();

  await input.db
    .update(schema.projectMemberOffboardingPlans)
    .set({ status: 'expired' })
    .where(
      and(
        eq(schema.projectMemberOffboardingPlans.projectId, input.project.id),
        eq(schema.projectMemberOffboardingPlans.memberUserId, input.memberUserId),
        eq(schema.projectMemberOffboardingPlans.status, 'preview'),
        sql`${schema.projectMemberOffboardingPlans.expiresAt} > ${nowIso}`
      )
    );

  await input.db.insert(schema.projectMemberOffboardingPlans).values({
    id: planId,
    projectId: input.project.id,
    memberUserId: input.memberUserId,
    requestedBy: input.requestedBy,
    status: 'preview',
    resourceSummaryJson: JSON.stringify(summary),
    createdAt: nowIso,
    expiresAt,
    appliedAt: null,
  });

  if (resources.length > 0) {
    await input.db.insert(schema.projectMemberOffboardingResourceActions).values(
      resources.map((resource) => ({
        id: offboardingActionId(),
        planId,
        resourceKind: resource.resourceKind,
        resourceId: resource.resourceId,
        credentialSourceBefore: resource.credentialSourceBefore,
        attributionUserIdBefore: resource.attributionUserIdBefore,
        attributionProjectIdBefore: resource.attributionProjectIdBefore,
        recommendedAction: resource.recommendedAction,
        selectedAction: null,
        status: 'pending',
        detailsJson: JSON.stringify(resource.details),
        createdAt: nowIso,
        updatedAt: nowIso,
      }))
    );
  }

  return {
    offboardingPlanId: planId,
    projectId: input.project.id,
    memberUserId: input.memberUserId,
    canApply: resources.length === 0,
    requiresHumanDecision: resources.length > 0,
    summary,
    resources: resources.map((resource): ProjectMemberOffboardingResourcePreview => ({ ...resource })),
  };
}
