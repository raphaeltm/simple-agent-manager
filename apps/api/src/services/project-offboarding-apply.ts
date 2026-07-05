import type {
  ProjectMemberOffboardingAction,
  ProjectMemberOffboardingApplyActionSelection,
  ProjectMemberOffboardingApplyResponse,
  ProjectMemberOffboardingResourceKind,
  ProjectMemberOffboardingResourceResult,
} from '@simple-agent-manager/shared';
import { and, eq, inArray, or } from 'drizzle-orm';

import * as schema from '../db/schema';
import { AppError, errors } from '../middleware/error';
import type { AppDb } from '../middleware/project-auth';
import { enumerateOffboardingResources } from './project-offboarding-preview-resources';

const TASK_BLOCKED_REASON = 'member_removed_credentials_unavailable';
const TRIGGER_BLOCKED_REASON = 'member_removed';
const NODE_BLOCKED_REASON = 'member_removed_credentials_unavailable';

type ResourceKey = `${ProjectMemberOffboardingResourceKind}:${string}`;
type OffboardingMutationDb = Pick<AppDb, 'update'>;

interface StoredAction {
  resourceKind: string;
  resourceId: string;
  credentialSourceBefore: string;
  attributionUserIdBefore: string | null;
  attributionProjectIdBefore: string | null;
  recommendedAction: string;
  detailsJson: string;
}

interface CurrentResource {
  resourceKind: ProjectMemberOffboardingResourceKind;
  resourceId: string;
  credentialSourceBefore: string;
  attributionUserIdBefore: string | null;
  attributionProjectIdBefore: string | null;
  recommendedAction: ProjectMemberOffboardingAction;
  availableActions: ProjectMemberOffboardingAction[];
  blocksRemoval: boolean;
  details: Record<string, unknown>;
}

function conflict(code: string, message: string, details?: Record<string, unknown>): AppError {
  return new AppError(409, code, message, details);
}

function resourceKey(kind: ProjectMemberOffboardingResourceKind, id: string): ResourceKey {
  return `${kind}:${id}`;
}

function selectionKey(selection: ProjectMemberOffboardingApplyActionSelection): ResourceKey {
  return resourceKey(selection.resourceKind, selection.resourceId);
}

function actionDetailsJson(resource: CurrentResource): string {
  return JSON.stringify(resource.details);
}

function findDuplicateActionKeys(
  actions: ProjectMemberOffboardingApplyActionSelection[]
): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const action of actions) {
    const key = selectionKey(action);
    if (seen.has(key)) duplicates.add(key);
    seen.add(key);
  }
  return Array.from(duplicates);
}

function assertPlanIsFresh(input: {
  storedActions: StoredAction[];
  currentResources: CurrentResource[];
}): void {
  const currentByKey = new Map(
    input.currentResources.map((resource) => [
      resourceKey(resource.resourceKind, resource.resourceId),
      resource,
    ])
  );
  if (input.storedActions.length !== input.currentResources.length) {
    throw conflict('stale_plan', 'Offboarding plan is stale; preview again');
  }

  for (const stored of input.storedActions) {
    const key = resourceKey(
      stored.resourceKind as ProjectMemberOffboardingResourceKind,
      stored.resourceId
    );
    const current = currentByKey.get(key);
    if (!current) {
      throw conflict('stale_plan', 'Offboarding plan is stale; preview again');
    }
    if (
      stored.credentialSourceBefore !== current.credentialSourceBefore ||
      stored.attributionUserIdBefore !== current.attributionUserIdBefore ||
      stored.attributionProjectIdBefore !== current.attributionProjectIdBefore ||
      stored.recommendedAction !== current.recommendedAction ||
      stored.detailsJson !== actionDetailsJson(current)
    ) {
      throw conflict('stale_plan', 'Offboarding plan is stale; preview again');
    }
  }
}

function assertAllLiveResourcesAddressed(input: {
  selectionsByKey: Map<ResourceKey, ProjectMemberOffboardingApplyActionSelection>;
  currentResources: CurrentResource[];
}): void {
  const unresolved = input.currentResources
    .filter((resource) => !input.selectionsByKey.has(resourceKey(resource.resourceKind, resource.resourceId)))
    .map((resource) => resourceKey(resource.resourceKind, resource.resourceId));
  if (unresolved.length > 0) {
    throw conflict(
      'unresolved_credential_attribution',
      'Offboarding apply must select an action for every live personal-backed resource',
      { unresolved }
    );
  }
}

function assertSelectedActionsAreAvailable(input: {
  selectionsByKey: Map<ResourceKey, ProjectMemberOffboardingApplyActionSelection>;
  currentResources: CurrentResource[];
}): void {
  const currentByKey = new Map(
    input.currentResources.map((resource) => [
      resourceKey(resource.resourceKind, resource.resourceId),
      resource,
    ])
  );
  for (const [key, selection] of input.selectionsByKey.entries()) {
    const current = currentByKey.get(key);
    if (!current) {
      throw conflict('unresolved_credential_attribution', 'Selected resource is not in the plan', {
        resource: key,
      });
    }
    if (!current.availableActions.includes(selection.action)) {
      throw conflict(
        'unresolved_credential_attribution',
        'Selected offboarding action is not available for the resource',
        { resource: key, action: selection.action }
      );
    }
  }
}

function resourceResult(input: {
  resource: CurrentResource;
  action: ProjectMemberOffboardingAction;
  status: 'applied' | 'skipped';
  blocksRemoval: boolean;
  message: string | null;
}): ProjectMemberOffboardingResourceResult {
  return {
    resourceKind: input.resource.resourceKind,
    resourceId: input.resource.resourceId,
    action: input.action,
    status: input.status,
    blocksRemoval: input.blocksRemoval,
    message: input.message,
  };
}

function stringDetail(details: Record<string, unknown>, key: string): string | null {
  const value = details[key];
  return typeof value === 'string' && value.trim() ? value : null;
}

async function applyTriggerAction(input: {
  tx: OffboardingMutationDb;
  projectId: string;
  actorUserId: string;
  nowIso: string;
  resource: CurrentResource;
  action: ProjectMemberOffboardingAction;
}): Promise<ProjectMemberOffboardingResourceResult> {
  if (input.action === 'defer_removal') {
    return resourceResult({
      resource: input.resource,
      action: input.action,
      status: 'skipped',
      blocksRemoval: true,
      message: 'Trigger removal deferred',
    });
  }
  if (input.action === 'reattach_to_project') {
    return resourceResult({
      resource: input.resource,
      action: input.action,
      status: 'applied',
      blocksRemoval: false,
      message: 'Trigger kept active using existing project credential coverage',
    });
  }

  const rows = await input.tx
    .update(schema.triggers)
    .set({
      status: 'disabled',
      nextFireAt: null,
      credentialBlockedReason: TRIGGER_BLOCKED_REASON,
      credentialBlockedAt: input.nowIso,
      credentialBlockedBy: input.actorUserId,
      updatedAt: input.nowIso,
    })
    .where(
      and(
        eq(schema.triggers.projectId, input.projectId),
        eq(schema.triggers.id, input.resource.resourceId),
        eq(schema.triggers.status, 'active')
      )
    )
    .returning({ id: schema.triggers.id });
  if (rows.length !== 1) {
    throw conflict('stale_plan', 'Trigger state changed; preview again');
  }

  return resourceResult({
    resource: input.resource,
    action: input.action,
    status: 'applied',
    blocksRemoval: false,
    message: 'Trigger disabled because departing member credentials are unavailable',
  });
}

async function applyTaskTreeAction(input: {
  tx: OffboardingMutationDb;
  projectId: string;
  nowIso: string;
  resource: CurrentResource;
  action: ProjectMemberOffboardingAction;
}): Promise<ProjectMemberOffboardingResourceResult> {
  const taskStatus = stringDetail(input.resource.details, 'status');
  if (input.action === 'defer_removal') {
    return resourceResult({
      resource: input.resource,
      action: input.action,
      status: 'skipped',
      blocksRemoval: true,
      message: 'Task tree removal deferred',
    });
  }
  if (taskStatus === 'running') {
    throw conflict(
      'unresolved_credential_attribution',
      'Running tasks attributed to departing personal credentials must be stopped or deferred before removal',
      { resource: resourceKey(input.resource.resourceKind, input.resource.resourceId) }
    );
  }
  if (input.action === 'reattach_to_project') {
    throw conflict(
      'unresolved_credential_attribution',
      'Task tree reattachment requires an available project credential action',
      { resource: resourceKey(input.resource.resourceKind, input.resource.resourceId) }
    );
  }

  const rows = await input.tx
    .update(schema.tasks)
    .set({
      status: 'failed',
      completedAt: input.nowIso,
      finalizedAt: input.nowIso,
      errorMessage: 'Departing member credentials are unavailable',
      credentialBlockedReason: TASK_BLOCKED_REASON,
      credentialBlockedAt: input.nowIso,
      updatedAt: input.nowIso,
    })
    .where(
      and(
        eq(schema.tasks.projectId, input.projectId),
        or(
          eq(schema.tasks.id, input.resource.resourceId),
          eq(schema.tasks.parentTaskId, input.resource.resourceId)
        ),
        eq(schema.tasks.credentialAttributionSource, 'user'),
        eq(schema.tasks.credentialAttributionUserId, input.resource.attributionUserIdBefore ?? ''),
        inArray(schema.tasks.status, ['draft', 'queued'])
      )
    )
    .returning({ id: schema.tasks.id });
  if (rows.length < 1) {
    throw conflict('stale_plan', 'Task tree state changed; preview again');
  }

  return resourceResult({
    resource: input.resource,
    action: input.action,
    status: 'applied',
    blocksRemoval: false,
    message: 'Queued task tree canceled because departing member credentials are unavailable',
  });
}

async function applyNodeAction(input: {
  tx: OffboardingMutationDb;
  projectId: string;
  memberUserId: string;
  nowIso: string;
  resource: CurrentResource;
  action: ProjectMemberOffboardingAction;
}): Promise<ProjectMemberOffboardingResourceResult> {
  if (input.action === 'defer_removal') {
    return resourceResult({
      resource: input.resource,
      action: input.action,
      status: 'skipped',
      blocksRemoval: true,
      message: 'Node removal deferred',
    });
  }
  if (input.action === 'reattach_to_project') {
    const rows = await input.tx
      .update(schema.nodes)
      .set({
        credentialSource: 'project',
        credentialAttributionSource: 'project',
        credentialAttributionUserId: null,
        credentialAttributionProjectId: input.projectId,
        offboardingStatus: null,
        offboardingBlockedReason: null,
        offboardingBlockedAt: null,
        updatedAt: input.nowIso,
      })
      .where(
        and(
          eq(schema.nodes.id, input.resource.resourceId),
          eq(schema.nodes.credentialAttributionSource, 'user'),
          eq(schema.nodes.credentialAttributionUserId, input.memberUserId)
        )
      )
      .returning({ id: schema.nodes.id });
    if (rows.length !== 1) {
      throw conflict('stale_plan', 'Node state changed; preview again');
    }
    return resourceResult({
      resource: input.resource,
      action: input.action,
      status: 'applied',
      blocksRemoval: false,
      message: 'Node reattached to existing project credential coverage',
    });
  }

  const rows = await input.tx
    .update(schema.nodes)
    .set({
      offboardingStatus: 'blocked',
      offboardingBlockedReason: NODE_BLOCKED_REASON,
      offboardingBlockedAt: input.nowIso,
      updatedAt: input.nowIso,
    })
    .where(
      and(
        eq(schema.nodes.id, input.resource.resourceId),
        eq(schema.nodes.credentialAttributionSource, 'user'),
        eq(schema.nodes.credentialAttributionUserId, input.memberUserId)
      )
    )
    .returning({ id: schema.nodes.id });
  if (rows.length !== 1) {
    throw conflict('stale_plan', 'Node state changed; preview again');
  }

  return resourceResult({
    resource: input.resource,
    action: input.action,
    status: 'applied',
    blocksRemoval: true,
    message: 'Node teardown is blocked because departing member credentials are unavailable',
  });
}

async function applyDeploymentEnvironmentAction(input: {
  tx: OffboardingMutationDb;
  projectId: string;
  memberUserId: string;
  nowIso: string;
  resource: CurrentResource;
  action: ProjectMemberOffboardingAction;
}): Promise<ProjectMemberOffboardingResourceResult> {
  if (input.action === 'defer_removal') {
    return resourceResult({
      resource: input.resource,
      action: input.action,
      status: 'skipped',
      blocksRemoval: true,
      message: 'Deployment environment removal deferred',
    });
  }

  const nodeId = stringDetail(input.resource.details, 'nodeId');
  if (!nodeId) {
    throw conflict('stale_plan', 'Deployment environment node attribution changed; preview again');
  }

  if (input.action === 'reattach_to_project') {
    const rows = await input.tx
      .update(schema.nodes)
      .set({
        credentialSource: 'project',
        credentialAttributionSource: 'project',
        credentialAttributionUserId: null,
        credentialAttributionProjectId: input.projectId,
        offboardingStatus: null,
        offboardingBlockedReason: null,
        offboardingBlockedAt: null,
        updatedAt: input.nowIso,
      })
      .where(
        and(
          eq(schema.nodes.id, nodeId),
          eq(schema.nodes.credentialAttributionSource, 'user'),
          eq(schema.nodes.credentialAttributionUserId, input.memberUserId)
        )
      )
      .returning({ id: schema.nodes.id });
    if (rows.length !== 1) {
      throw conflict('stale_plan', 'Deployment node state changed; preview again');
    }
    return resourceResult({
      resource: input.resource,
      action: input.action,
      status: 'applied',
      blocksRemoval: false,
      message: 'Deployment node reattached to existing project credential coverage',
    });
  }

  const envRows = await input.tx
    .update(schema.deploymentEnvironments)
    .set({
      offboardingStatus: 'blocked',
      updatedAt: input.nowIso,
    })
    .where(
      and(
        eq(schema.deploymentEnvironments.projectId, input.projectId),
        eq(schema.deploymentEnvironments.id, input.resource.resourceId),
        eq(schema.deploymentEnvironments.nodeId, nodeId)
      )
    )
    .returning({ id: schema.deploymentEnvironments.id });
  if (envRows.length !== 1) {
    throw conflict('stale_plan', 'Deployment environment state changed; preview again');
  }

  await input.tx
    .update(schema.nodes)
    .set({
      offboardingStatus: 'blocked',
      offboardingBlockedReason: NODE_BLOCKED_REASON,
      offboardingBlockedAt: input.nowIso,
      updatedAt: input.nowIso,
    })
    .where(
      and(
        eq(schema.nodes.id, nodeId),
        eq(schema.nodes.credentialAttributionSource, 'user'),
        eq(schema.nodes.credentialAttributionUserId, input.memberUserId)
      )
    );

  return resourceResult({
    resource: input.resource,
    action: input.action,
    status: 'applied',
    blocksRemoval: true,
    message: 'Deployment node teardown is blocked because departing member credentials are unavailable',
  });
}

async function applyProjectAttachmentAction(input: {
  tx: OffboardingMutationDb;
  projectId: string;
  nowIso: string;
  resource: CurrentResource;
  action: ProjectMemberOffboardingAction;
}): Promise<ProjectMemberOffboardingResourceResult> {
  if (input.action === 'defer_removal') {
    return resourceResult({
      resource: input.resource,
      action: input.action,
      status: 'skipped',
      blocksRemoval: true,
      message: 'Project credential attachment removal deferred',
    });
  }

  const rows = await input.tx
    .update(schema.ccAttachments)
    .set({ isActive: false, updatedAt: input.nowIso })
    .where(
      and(
        eq(schema.ccAttachments.projectId, input.projectId),
        eq(schema.ccAttachments.id, input.resource.resourceId),
        eq(schema.ccAttachments.isActive, true)
      )
    )
    .returning({ id: schema.ccAttachments.id });
  if (rows.length !== 1) {
    throw conflict('stale_plan', 'Project credential attachment state changed; preview again');
  }

  return resourceResult({
    resource: input.resource,
    action: input.action,
    status: 'applied',
    blocksRemoval: false,
    message:
      input.action === 'reattach_to_project'
        ? 'Departing member attachment disabled; remaining project coverage is already active'
        : 'Departing member attachment disabled',
  });
}

async function applyResourceAction(input: {
  tx: OffboardingMutationDb;
  projectId: string;
  memberUserId: string;
  actorUserId: string;
  nowIso: string;
  resource: CurrentResource;
  action: ProjectMemberOffboardingAction;
}): Promise<ProjectMemberOffboardingResourceResult> {
  switch (input.resource.resourceKind) {
    case 'trigger':
      return applyTriggerAction(input);
    case 'task_tree':
      return applyTaskTreeAction(input);
    case 'node':
      return applyNodeAction(input);
    case 'deployment_environment':
      return applyDeploymentEnvironmentAction(input);
    case 'project_attachment':
      return applyProjectAttachmentAction(input);
    default:
      throw errors.badRequest('Unsupported offboarding resource kind');
  }
}

export async function applyProjectMemberOffboarding(input: {
  db: AppDb;
  project: schema.Project;
  memberUserId: string;
  actorUserId: string;
  planId: string;
  actions: ProjectMemberOffboardingApplyActionSelection[];
  finalMemberStatus: 'removed';
  defaultAgentType: string;
  now?: Date;
}): Promise<ProjectMemberOffboardingApplyResponse> {
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const duplicateKeys = findDuplicateActionKeys(input.actions);
  if (duplicateKeys.length > 0) {
    throw errors.badRequest('Duplicate offboarding action selections', { duplicateKeys });
  }

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
    throw conflict(
      'last_owner_requires_transfer',
      'Ownership must be transferred before offboarding the sole project owner'
    );
  }

  const planRows = await input.db
    .select()
    .from(schema.projectMemberOffboardingPlans)
    .where(
      and(
        eq(schema.projectMemberOffboardingPlans.id, input.planId),
        eq(schema.projectMemberOffboardingPlans.projectId, input.project.id),
        eq(schema.projectMemberOffboardingPlans.memberUserId, input.memberUserId)
      )
    )
    .limit(1);
  const plan = planRows[0];
  if (!plan) {
    throw errors.notFound('Offboarding plan');
  }
  if (plan.status !== 'preview') {
    throw conflict('stale_plan', 'Offboarding plan is no longer applyable; preview again');
  }
  if (new Date(plan.expiresAt).getTime() <= now.getTime()) {
    throw conflict('expired_plan', 'Offboarding plan has expired; preview again');
  }

  const storedActions = (await input.db
    .select({
      resourceKind: schema.projectMemberOffboardingResourceActions.resourceKind,
      resourceId: schema.projectMemberOffboardingResourceActions.resourceId,
      credentialSourceBefore: schema.projectMemberOffboardingResourceActions.credentialSourceBefore,
      attributionUserIdBefore:
        schema.projectMemberOffboardingResourceActions.attributionUserIdBefore,
      attributionProjectIdBefore:
        schema.projectMemberOffboardingResourceActions.attributionProjectIdBefore,
      recommendedAction: schema.projectMemberOffboardingResourceActions.recommendedAction,
      detailsJson: schema.projectMemberOffboardingResourceActions.detailsJson,
    })
    .from(schema.projectMemberOffboardingResourceActions)
    .where(eq(schema.projectMemberOffboardingResourceActions.planId, input.planId))) as StoredAction[];

  const currentResources = (await enumerateOffboardingResources({
    db: input.db,
    project: input.project,
    memberUserId: input.memberUserId,
    defaultAgentType: input.defaultAgentType,
  })) as CurrentResource[];

  assertPlanIsFresh({ storedActions, currentResources });

  const selectionsByKey = new Map(input.actions.map((action) => [selectionKey(action), action]));
  assertAllLiveResourcesAddressed({ selectionsByKey, currentResources });
  assertSelectedActionsAreAvailable({ selectionsByKey, currentResources });

  const resourceResults: ProjectMemberOffboardingResourceResult[] = [];
  await input.db.transaction(async (tx) => {
    for (const resource of currentResources) {
      const selection = selectionsByKey.get(resourceKey(resource.resourceKind, resource.resourceId));
      if (!selection) {
        throw conflict(
          'unresolved_credential_attribution',
          'Offboarding action missing for resource'
        );
      }
      const result = await applyResourceAction({
        tx,
        projectId: input.project.id,
        memberUserId: input.memberUserId,
        actorUserId: input.actorUserId,
        nowIso,
        resource,
        action: selection.action,
      });
      resourceResults.push(result);
      await tx
        .update(schema.projectMemberOffboardingResourceActions)
        .set({
          selectedAction: selection.action,
          status: result.status,
          updatedAt: nowIso,
        })
        .where(
          and(
            eq(schema.projectMemberOffboardingResourceActions.planId, input.planId),
            eq(schema.projectMemberOffboardingResourceActions.resourceKind, resource.resourceKind),
            eq(schema.projectMemberOffboardingResourceActions.resourceId, resource.resourceId)
          )
        );
    }

    const hasBlockers = resourceResults.some((result) => result.blocksRemoval);
    if (!hasBlockers && input.finalMemberStatus === 'removed') {
      const memberRows = await tx
        .update(schema.projectMembers)
        .set({
          status: 'removed',
          removedAt: nowIso,
          updatedAt: nowIso,
        })
        .where(
          and(
            eq(schema.projectMembers.projectId, input.project.id),
            eq(schema.projectMembers.userId, input.memberUserId),
            eq(schema.projectMembers.status, 'active')
          )
        )
        .returning({ userId: schema.projectMembers.userId });
      if (memberRows.length !== 1) {
        throw conflict('stale_plan', 'Project membership changed; preview again');
      }
    }

    await tx
      .update(schema.projectMemberOffboardingPlans)
      .set({
        status: 'applied',
        appliedAt: nowIso,
      })
      .where(
        and(
          eq(schema.projectMemberOffboardingPlans.id, input.planId),
          eq(schema.projectMemberOffboardingPlans.projectId, input.project.id),
          eq(schema.projectMemberOffboardingPlans.memberUserId, input.memberUserId),
          eq(schema.projectMemberOffboardingPlans.status, 'preview')
        )
      );
  });

  return {
    projectId: input.project.id,
    memberUserId: input.memberUserId,
    status: resourceResults.some((result) => result.blocksRemoval)
      ? (targetMember.status as ProjectMemberOffboardingApplyResponse['status'])
      : 'removed',
    appliedAt: nowIso,
    resourceResults,
  };
}
