import type {
  ProjectMemberOffboardingPreviewResponse,
  ProjectMemberOffboardingResourcePreview,
} from '@simple-agent-manager/shared';
import { and, eq, sql } from 'drizzle-orm';

import * as schema from '../db/schema';
import { ulid } from '../lib/ulid';
import { AppError, errors } from '../middleware/error';
import type { AppDb } from '../middleware/project-auth';
import {
  enumerateOffboardingResources,
  summarizeOffboardingResources,
} from './project-offboarding-preview-resources';

const DEFAULT_OFFBOARDING_PLAN_TTL_SECONDS = 15 * 60;

function offboardingPlanId(): string {
  return `off_${ulid()}`;
}

function offboardingActionId(): string {
  return `offact_${ulid()}`;
}

function resolveOffboardingPlanTtlMs(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? '', 10);
  const ttlSeconds =
    Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_OFFBOARDING_PLAN_TTL_SECONDS;
  return ttlSeconds * 1000;
}

export async function createProjectMemberOffboardingPreview(input: {
  db: AppDb;
  project: schema.Project;
  memberUserId: string;
  requestedBy: string;
  defaultAgentType: string;
  planTtlSeconds?: string;
  now?: Date;
}): Promise<ProjectMemberOffboardingPreviewResponse> {
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const expiresAt = new Date(
    now.getTime() + resolveOffboardingPlanTtlMs(input.planTtlSeconds)
  ).toISOString();

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

  const resources = await enumerateOffboardingResources({
    db: input.db,
    project: input.project,
    memberUserId: input.memberUserId,
    defaultAgentType: input.defaultAgentType,
  });
  const summary = summarizeOffboardingResources(resources);
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
