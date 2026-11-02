/**
 * Per-resource actions for project member offboarding (`applyProjectMemberOffboarding`
 * in project-offboarding-apply.ts): what break-and-flag, reattach, or defer does to
 * each kind of resource the departing member's credentials were attributed to.
 */
import type {
  ProjectMemberOffboardingAction,
  ProjectMemberOffboardingResourceKind,
  ProjectMemberOffboardingResourceResult,
} from '@simple-agent-manager/shared';
import { and, eq, inArray, or } from 'drizzle-orm';

import * as schema from '../db/schema';
import { AppError, errors } from '../middleware/error';
import type { AppDb } from '../middleware/project-auth';

const TASK_BLOCKED_REASON = 'member_removed_credentials_unavailable';
const TRIGGER_BLOCKED_REASON = 'member_removed';
const NODE_BLOCKED_REASON = 'member_removed_credentials_unavailable';

export type OffboardingMutationDb = Pick<AppDb, 'update'>;
export type ResourceKey = `${ProjectMemberOffboardingResourceKind}:${string}`;

export function resourceKey(kind: ProjectMemberOffboardingResourceKind, id: string): ResourceKey {
  return `${kind}:${id}`;
}

export interface CurrentResource {
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

export function conflict(
  code: string,
  message: string,
  details?: Record<string, unknown>
): AppError {
  return new AppError(409, code, message, details);
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
  memberUserId: string;
  actorUserId: string;
  executionPrincipalUserId: string | null;
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
    // The installed principal must be someone who REMAINS and is currently
    // authorized. Using the actor unconditionally installed the departing member
    // on self-offboarding, and the removal below then left the trigger executing
    // as a removed member. Fail closed rather than install an unusable principal.
    const executionPrincipalUserId = input.executionPrincipalUserId;
    if (!executionPrincipalUserId || executionPrincipalUserId === input.memberUserId) {
      throw conflict(
        'unresolved_credential_attribution',
        'No remaining project member is authorized to execute this trigger; choose break_and_flag or defer_removal'
      );
    }
    const rows = await input.tx
      .update(schema.triggers)
      .set({
        executionUserId: executionPrincipalUserId,
        executionUserAuthorizedAt: input.nowIso,
        // Who approved the transfer stays the acting user, even when the
        // principal itself had to fall back to another authorized member.
        executionUserAuthorizedBy: input.actorUserId,
        credentialBlockedReason: null,
        credentialBlockedAt: null,
        credentialBlockedBy: null,
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
      message: 'Trigger kept active using an authorized project execution principal',
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

  const nodeRows = await input.tx
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
    )
    .returning({ id: schema.nodes.id });
  if (nodeRows.length !== 1) {
    throw conflict('stale_plan', 'Deployment node state changed; preview again');
  }

  return resourceResult({
    resource: input.resource,
    action: input.action,
    status: 'applied',
    blocksRemoval: true,
    message:
      'Deployment node teardown is blocked because departing member credentials are unavailable',
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

export async function applyResourceAction(input: {
  tx: OffboardingMutationDb;
  projectId: string;
  memberUserId: string;
  actorUserId: string;
  executionPrincipalUserId: string | null;
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
