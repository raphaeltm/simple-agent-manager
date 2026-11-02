import type {
  ProjectMemberOffboardingApplyActionSelection,
  ProjectMemberOffboardingApplyResponse,
  ProjectMemberOffboardingResourceKind,
  ProjectMemberOffboardingResourceResult,
} from '@simple-agent-manager/shared';
import { and, eq } from 'drizzle-orm';

import * as schema from '../db/schema';
import { errors } from '../middleware/error';
import type { AppDb } from '../middleware/project-auth';
import { enumerateOffboardingResources } from './project-offboarding-preview-resources';
import { deleteProjectProfilePins } from './project-offboarding-profile-pins';
import {
  applyResourceAction,
  conflict,
  type CurrentResource,
  type OffboardingMutationDb,
  type ResourceKey,
  resourceKey,
} from './project-offboarding-resource-actions';
import { selectTriggerExecutionPrincipal } from './trigger-execution-principal';

interface StoredAction {
  resourceKind: string;
  resourceId: string;
  credentialSourceBefore: string;
  attributionUserIdBefore: string | null;
  attributionProjectIdBefore: string | null;
  recommendedAction: string;
  detailsJson: string;
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
    .filter(
      (resource) =>
        !input.selectionsByKey.has(resourceKey(resource.resourceKind, resource.resourceId))
    )
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
    .where(
      eq(schema.projectMemberOffboardingResourceActions.planId, input.planId)
    )) as StoredAction[];

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

  // Resolved once per apply from CURRENT membership. The actor wins when they
  // remain and are still capable — that keeps ordinary offboarding unchanged and
  // preserves the explicit-decision model. Self-offboarding, or an actor who has
  // lost `task:write`, deterministically falls back to another authorized
  // remaining member; `null` means keep-active is impossible and reattach fails
  // closed instead of installing a principal that is about to be removed.
  const executionPrincipalUserId =
    selectTriggerExecutionPrincipal({
      members,
      departingUserId: input.memberUserId,
      preferredUserId: input.actorUserId,
    })?.userId ?? null;

  const resourceResults: ProjectMemberOffboardingResourceResult[] = [];
  const mutationDb: OffboardingMutationDb = input.db;
  for (const resource of currentResources) {
    const selection = selectionsByKey.get(resourceKey(resource.resourceKind, resource.resourceId));
    if (!selection) {
      throw conflict(
        'unresolved_credential_attribution',
        'Offboarding action missing for resource'
      );
    }
    const result = await applyResourceAction({
      tx: mutationDb,
      projectId: input.project.id,
      memberUserId: input.memberUserId,
      actorUserId: input.actorUserId,
      executionPrincipalUserId,
      nowIso,
      resource,
      action: selection.action,
    });
    resourceResults.push(result);
    const auditRows = await mutationDb
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
      )
      .returning({ resourceId: schema.projectMemberOffboardingResourceActions.resourceId });
    if (auditRows.length !== 1) {
      throw conflict('stale_plan', 'Offboarding resource action changed; preview again');
    }
  }

  const hasBlockers = resourceResults.some((result) => result.blocksRemoval);
  let removedProfilePinCount = 0;
  if (!hasBlockers && input.finalMemberStatus === 'removed') {
    const memberRows = await mutationDb
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
    // Private account choices that only applied to this member's runs here.
    removedProfilePinCount = await deleteProjectProfilePins(
      input.db,
      input.project.id,
      input.memberUserId
    );
  }

  const appliedPlanRows = await mutationDb
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
    )
    .returning({ id: schema.projectMemberOffboardingPlans.id });
  if (appliedPlanRows.length !== 1) {
    throw conflict('stale_plan', 'Offboarding plan changed; preview again');
  }

  return {
    projectId: input.project.id,
    memberUserId: input.memberUserId,
    status: resourceResults.some((result) => result.blocksRemoval)
      ? (targetMember.status as ProjectMemberOffboardingApplyResponse['status'])
      : 'removed',
    appliedAt: nowIso,
    resourceResults,
    removedProfilePinCount,
  };
}
