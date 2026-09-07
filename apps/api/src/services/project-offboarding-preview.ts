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
  database?: D1Database;
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

  await persistPreviewPlan({
    db: input.db,
    database: input.database,
    projectId: input.project.id,
    memberUserId: input.memberUserId,
    requestedBy: input.requestedBy,
    planId,
    summaryJson: JSON.stringify(summary),
    resources,
    nowIso,
    expiresAt,
  });

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

async function persistPreviewPlan(input: {
  db: AppDb;
  database?: D1Database;
  projectId: string;
  memberUserId: string;
  requestedBy: string;
  planId: string;
  summaryJson: string;
  resources: ProjectMemberOffboardingResourcePreview[];
  nowIso: string;
  expiresAt: string;
}): Promise<void> {
  if (
    input.database &&
    typeof input.database.prepare === 'function' &&
    typeof input.database.batch === 'function'
  ) {
    const statements: D1PreparedStatement[] = [
      input.database
        .prepare(
          `UPDATE project_member_offboarding_plans
           SET status = 'expired'
           WHERE project_id = ? AND member_user_id = ? AND status = 'preview' AND expires_at > ?`
        )
        .bind(input.projectId, input.memberUserId, input.nowIso),
      input.database
        .prepare(
          `INSERT INTO project_member_offboarding_plans
           (id, project_id, member_user_id, requested_by, status, resource_summary_json, created_at, expires_at, applied_at)
           VALUES (?, ?, ?, ?, 'preview', ?, ?, ?, NULL)`
        )
        .bind(
          input.planId,
          input.projectId,
          input.memberUserId,
          input.requestedBy,
          input.summaryJson,
          input.nowIso,
          input.expiresAt
        ),
    ];

    for (const resource of input.resources) {
      statements.push(
        input.database
          .prepare(
            `INSERT INTO project_member_offboarding_resource_actions
             (id, plan_id, resource_kind, resource_id, credential_source_before,
              attribution_user_id_before, attribution_project_id_before,
              recommended_action, selected_action, status, details_json, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 'pending', ?, ?, ?)`
          )
          .bind(
            offboardingActionId(),
            input.planId,
            resource.resourceKind,
            resource.resourceId,
            resource.credentialSourceBefore,
            resource.attributionUserIdBefore,
            resource.attributionProjectIdBefore,
            resource.recommendedAction,
            JSON.stringify(resource.details),
            input.nowIso,
            input.nowIso
          )
      );
    }

    await input.database.batch(statements);
    return;
  }

  await input.db
    .update(schema.projectMemberOffboardingPlans)
    .set({ status: 'expired' })
    .where(
      and(
        eq(schema.projectMemberOffboardingPlans.projectId, input.projectId),
        eq(schema.projectMemberOffboardingPlans.memberUserId, input.memberUserId),
        eq(schema.projectMemberOffboardingPlans.status, 'preview'),
        sql`${schema.projectMemberOffboardingPlans.expiresAt} > ${input.nowIso}`
      )
    );

  await input.db.insert(schema.projectMemberOffboardingPlans).values({
    id: input.planId,
    projectId: input.projectId,
    memberUserId: input.memberUserId,
    requestedBy: input.requestedBy,
    status: 'preview',
    resourceSummaryJson: input.summaryJson,
    createdAt: input.nowIso,
    expiresAt: input.expiresAt,
    appliedAt: null,
  });

  if (input.resources.length > 0) {
    await input.db.insert(schema.projectMemberOffboardingResourceActions).values(
      input.resources.map((resource) => ({
        id: offboardingActionId(),
        planId: input.planId,
        resourceKind: resource.resourceKind,
        resourceId: resource.resourceId,
        credentialSourceBefore: resource.credentialSourceBefore,
        attributionUserIdBefore: resource.attributionUserIdBefore,
        attributionProjectIdBefore: resource.attributionProjectIdBefore,
        recommendedAction: resource.recommendedAction,
        selectedAction: null,
        status: 'pending',
        detailsJson: JSON.stringify(resource.details),
        createdAt: input.nowIso,
        updatedAt: input.nowIso,
      }))
    );
  }
}
