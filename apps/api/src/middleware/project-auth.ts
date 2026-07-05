import { and, eq } from 'drizzle-orm';
import { type drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import { errors } from './error';

export type AppDb = ReturnType<typeof drizzle<typeof schema>>;

export const PROJECT_MEMBER_ROLES = ['owner', 'admin', 'maintainer', 'viewer'] as const;
export type ProjectMemberRole = (typeof PROJECT_MEMBER_ROLES)[number];

export const PROJECT_MEMBER_STATUSES = ['active', 'invited', 'suspended', 'removed'] as const;
export type ProjectMemberStatus = (typeof PROJECT_MEMBER_STATUSES)[number];

export const PROJECT_CAPABILITIES = [
  'project:read',
  'project:update',
  'project:delete',
  'project:transfer_ownership',
  'task:read',
  'task:write',
  'workspace:read',
  'workspace:write',
  'deployment:read',
  'deployment:deploy',
  'deployment:manage',
  'secret:read',
  'secret:write',
  'infra:manage',
  'member:manage',
] as const;
export type ProjectCapability = (typeof PROJECT_CAPABILITIES)[number];

const ROLE_CAPABILITIES: Record<ProjectMemberRole, ReadonlySet<ProjectCapability>> = {
  owner: new Set(PROJECT_CAPABILITIES),
  admin: new Set(
    PROJECT_CAPABILITIES.filter(
      (capability) =>
        capability !== 'project:delete' && capability !== 'project:transfer_ownership'
    )
  ),
  maintainer: new Set([
    'project:read',
    'task:read',
    'task:write',
    'workspace:read',
    'workspace:write',
    'deployment:read',
    'deployment:deploy',
    'secret:read',
  ]),
  viewer: new Set(['project:read', 'task:read', 'workspace:read', 'deployment:read']),
};

/**
 * Defence-in-depth identity check. The query WHERE clause already filters on
 * `userId`, so in normal operation a row is only returned when it belongs to
 * the caller. This extra check guards against future regressions where the
 * WHERE clause might be weakened (typo, refactor, or ORM bug) — if for any
 * reason a row with a mismatched `userId` reaches us, we reject it as
 * `notFound` rather than treating it as a valid match.
 *
 * MEDIUM #8: explicit post-query check for cross-user IDOR defence-in-depth.
 */
function assertOwnership<T extends { userId: string }>(
  row: T | undefined,
  userId: string,
  resource: string
): T {
  if (!row || row.userId !== userId) {
    throw errors.notFound(resource);
  }
  return row;
}

function assertProject<T extends { id: string }>(
  row: T | undefined,
  projectId: string,
  resource: string
): T {
  if (!row || row.id !== projectId) {
    throw errors.notFound(resource);
  }
  return row;
}

function assertActiveMembership(
  row: schema.ProjectMember | undefined,
  projectId: string,
  userId: string
): schema.ProjectMember {
  if (
    !row ||
    row.projectId !== projectId ||
    row.userId !== userId ||
    row.status !== 'active'
  ) {
    throw errors.notFound('Project');
  }
  return row;
}

function parseProjectMemberRole(role: string): ProjectMemberRole | null {
  return PROJECT_MEMBER_ROLES.includes(role as ProjectMemberRole)
    ? (role as ProjectMemberRole)
    : null;
}

function roleHasCapability(role: string, capability: ProjectCapability): boolean {
  const parsedRole = parseProjectMemberRole(role);
  if (!parsedRole) return false;
  return ROLE_CAPABILITIES[parsedRole].has(capability);
}

async function requireActiveProjectMembership(
  db: AppDb,
  projectId: string,
  userId: string
): Promise<{ project: schema.Project; membership: schema.ProjectMember }> {
  const projectRows = await db
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.id, projectId))
    .limit(1);
  const project = assertProject(projectRows[0], projectId, 'Project');

  const memberRows = await db
    .select()
    .from(schema.projectMembers)
    .where(
      and(
        eq(schema.projectMembers.projectId, projectId),
        eq(schema.projectMembers.userId, userId),
        eq(schema.projectMembers.status, 'active')
      )
    )
    .limit(1);
  const membership = assertActiveMembership(memberRows[0], projectId, userId);

  return { project, membership };
}

export async function createOwnerProjectMembership(
  db: AppDb,
  projectId: string,
  userId: string,
  invitedBy: string | null = userId,
  now: string = new Date().toISOString()
): Promise<void> {
  await db
    .insert(schema.projectMembers)
    .values({
      projectId,
      userId,
      role: 'owner',
      status: 'active',
      invitedBy,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [schema.projectMembers.projectId, schema.projectMembers.userId],
      set: {
        role: 'owner',
        status: 'active',
        invitedBy,
        updatedAt: now,
      },
    });
}

export async function requireProjectAccess(
  db: AppDb,
  projectId: string,
  userId: string
): Promise<schema.Project> {
  const { project } = await requireActiveProjectMembership(db, projectId, userId);
  return project;
}

export async function requireProjectCapability(
  db: AppDb,
  projectId: string,
  userId: string,
  capability: ProjectCapability
): Promise<schema.Project> {
  const { project, membership } = await requireActiveProjectMembership(db, projectId, userId);
  if (!roleHasCapability(membership.role, capability)) {
    throw errors.forbidden('Project capability is required');
  }
  return project;
}

export async function requireOwnedProject(
  db: AppDb,
  projectId: string,
  userId: string
): Promise<schema.Project> {
  const rows = await db
    .select()
    .from(schema.projects)
    .where(and(eq(schema.projects.id, projectId), eq(schema.projects.userId, userId)))
    .limit(1);

  return assertOwnership(rows[0], userId, 'Project');
}

export async function requireOwnedTask(
  db: AppDb,
  projectId: string,
  taskId: string,
  userId: string
): Promise<schema.Task> {
  const rows = await db
    .select()
    .from(schema.tasks)
    .where(
      and(
        eq(schema.tasks.id, taskId),
        eq(schema.tasks.projectId, projectId),
        eq(schema.tasks.userId, userId)
      )
    )
    .limit(1);

  // Task has an additional projectId invariant beyond userId.
  const task = rows[0];
  if (!task || task.userId !== userId || task.projectId !== projectId) {
    throw errors.notFound('Task');
  }
  return task;
}

export async function requireOwnedWorkspace(
  db: AppDb,
  workspaceId: string,
  userId: string
): Promise<schema.Workspace> {
  const rows = await db
    .select()
    .from(schema.workspaces)
    .where(and(eq(schema.workspaces.id, workspaceId), eq(schema.workspaces.userId, userId)))
    .limit(1);

  return assertOwnership(rows[0], userId, 'Workspace');
}
