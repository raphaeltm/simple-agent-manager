/**
 * project-auth middleware — behavioral tests.
 *
 * These helpers are IDOR boundaries for project-scoped routes. Tests construct
 * mismatched rows directly so a weakened query or bad stub cannot bypass the
 * explicit defense-in-depth checks.
 */
import { describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { AppDb } from '../../../src/middleware/project-auth';
import {
  createOwnerProjectMembership,
  requireOwnedProject,
  requireOwnedTask,
  requireOwnedWorkspace,
  requireProjectAccess,
  requireProjectCapability,
} from '../../../src/middleware/project-auth';

function makeDb(dataByTable: Map<unknown, unknown[]>): AppDb {
  let currentTable: unknown = null;
  const chain = {
    from: (table: unknown) => {
      currentTable = table;
      return chain;
    },
    where: () => chain,
    limit: () => Promise.resolve(dataByTable.get(currentTable) ?? []),
  };
  return {
    select: () => chain,
  } as unknown as AppDb;
}

function makeProject(overrides: Partial<schema.Project> = {}): schema.Project {
  return {
    id: 'p1',
    userId: 'u1',
    name: 'Test',
    description: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as unknown as schema.Project;
}

function makeMember(overrides: Partial<schema.ProjectMember> = {}): schema.ProjectMember {
  const now = new Date().toISOString();
  return {
    projectId: 'p1',
    userId: 'u1',
    role: 'owner',
    status: 'active',
    invitedBy: 'u1',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('requireOwnedProject', () => {
  it('returns the project when userId matches the stored owner', async () => {
    const project = makeProject();
    const db = makeDb(new Map([[schema.projects, [project]]]));

    const result = await requireOwnedProject(db, 'p1', 'u1');

    expect(result).toEqual(project);
  });

  it('throws notFound when the project exists but belongs to another user', async () => {
    const db = makeDb(new Map([[schema.projects, []]]));

    await expect(requireOwnedProject(db, 'p1', 'u1')).rejects.toMatchObject({
      statusCode: 404,
      error: 'NOT_FOUND',
    });
  });

  it('throws notFound when no project with that id exists', async () => {
    const db = makeDb(new Map([[schema.projects, []]]));

    await expect(requireOwnedProject(db, 'p-missing', 'u1')).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it('throws notFound when DB returns a row with mismatched userId', async () => {
    const foreignProject = makeProject({ userId: 'u2', name: 'Foreign' });
    const db = makeDb(new Map([[schema.projects, [foreignProject]]]));

    await expect(requireOwnedProject(db, 'p1', 'u1')).rejects.toMatchObject({
      statusCode: 404,
      error: 'NOT_FOUND',
    });
  });
});

describe('requireProjectAccess', () => {
  it('returns the project for an active member who is not the project owner', async () => {
    const project = makeProject({ userId: 'owner-user' });
    const member = makeMember({ userId: 'member-user', role: 'viewer' });
    const db = makeDb(new Map([[schema.projects, [project]], [schema.projectMembers, [member]]]));

    const result = await requireProjectAccess(db, 'p1', 'member-user');

    expect(result).toEqual(project);
  });

  it('throws notFound for inactive membership', async () => {
    const project = makeProject({ userId: 'owner-user' });
    const member = makeMember({ userId: 'member-user', status: 'suspended' });
    const db = makeDb(new Map([[schema.projects, [project]], [schema.projectMembers, [member]]]));

    await expect(requireProjectAccess(db, 'p1', 'member-user')).rejects.toMatchObject({
      statusCode: 404,
      error: 'NOT_FOUND',
    });
  });

  it('throws notFound when DB returns a membership for a different user', async () => {
    const project = makeProject({ userId: 'owner-user' });
    const member = makeMember({ userId: 'other-user' });
    const db = makeDb(new Map([[schema.projects, [project]], [schema.projectMembers, [member]]]));

    await expect(requireProjectAccess(db, 'p1', 'member-user')).rejects.toMatchObject({
      statusCode: 404,
      error: 'NOT_FOUND',
    });
  });

  it('throws notFound when DB returns a project row for a different project', async () => {
    const project = makeProject({ id: 'p-other' });
    const member = makeMember();
    const db = makeDb(new Map([[schema.projects, [project]], [schema.projectMembers, [member]]]));

    await expect(requireProjectAccess(db, 'p1', 'u1')).rejects.toMatchObject({
      statusCode: 404,
      error: 'NOT_FOUND',
    });
  });
});

describe('requireProjectCapability', () => {
  it('allows a member whose role grants the requested capability', async () => {
    const project = makeProject({ userId: 'owner-user' });
    const member = makeMember({ userId: 'member-user', role: 'maintainer' });
    const db = makeDb(new Map([[schema.projects, [project]], [schema.projectMembers, [member]]]));

    const result = await requireProjectCapability(db, 'p1', 'member-user', 'deployment:deploy');

    expect(result).toEqual(project);
  });

  it('throws forbidden when the active role lacks the requested capability', async () => {
    const project = makeProject({ userId: 'owner-user' });
    const member = makeMember({ userId: 'member-user', role: 'viewer' });
    const db = makeDb(new Map([[schema.projects, [project]], [schema.projectMembers, [member]]]));

    await expect(requireProjectCapability(db, 'p1', 'member-user', 'task:write')).rejects.toMatchObject({
      statusCode: 403,
      error: 'FORBIDDEN',
    });
  });

  it('throws forbidden for an unknown active role', async () => {
    const project = makeProject({ userId: 'owner-user' });
    const member = makeMember({ userId: 'member-user', role: 'unexpected-role' });
    const db = makeDb(new Map([[schema.projects, [project]], [schema.projectMembers, [member]]]));

    await expect(requireProjectCapability(db, 'p1', 'member-user', 'project:read')).rejects.toMatchObject({
      statusCode: 403,
      error: 'FORBIDDEN',
    });
  });
});

describe('createOwnerProjectMembership', () => {
  it('upserts an active owner membership for project creation paths', async () => {
    const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
    const values = vi.fn().mockReturnValue({ onConflictDoUpdate });
    const insert = vi.fn().mockReturnValue({ values });
    const db = { insert } as unknown as AppDb;

    await createOwnerProjectMembership(db, 'p1', 'u1', 'inviter-user', '2026-07-01T00:00:00.000Z');

    expect(insert).toHaveBeenCalledWith(schema.projectMembers);
    expect(values).toHaveBeenCalledWith({
      projectId: 'p1',
      userId: 'u1',
      role: 'owner',
      status: 'active',
      invitedBy: 'inviter-user',
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-01T00:00:00.000Z',
    });
    expect(onConflictDoUpdate).toHaveBeenCalledWith({
      target: [schema.projectMembers.projectId, schema.projectMembers.userId],
      set: {
        role: 'owner',
        status: 'active',
        invitedBy: 'inviter-user',
        updatedAt: '2026-07-01T00:00:00.000Z',
      },
    });
  });
});

describe('requireOwnedTask', () => {
  it('returns the task when userId and projectId both match', async () => {
    const task: schema.Task = {
      id: 't1',
      projectId: 'p1',
      userId: 'u1',
      status: 'queued',
    } as unknown as schema.Task;

    const db = makeDb(new Map([[schema.tasks, [task]]]));
    const result = await requireOwnedTask(db, 'p1', 't1', 'u1');
    expect(result).toEqual(task);
  });

  it('throws notFound when the task belongs to another user', async () => {
    const db = makeDb(new Map([[schema.tasks, []]]));
    await expect(requireOwnedTask(db, 'p1', 't1', 'u1')).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it('throws notFound when DB returns a task with mismatched userId', async () => {
    const foreignTask = {
      id: 't1',
      projectId: 'p1',
      userId: 'u2',
      status: 'queued',
    } as unknown as schema.Task;

    const db = makeDb(new Map([[schema.tasks, [foreignTask]]]));
    await expect(requireOwnedTask(db, 'p1', 't1', 'u1')).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it('throws notFound when DB returns a task with mismatched projectId', async () => {
    const foreignTask = {
      id: 't1',
      projectId: 'p-other',
      userId: 'u1',
      status: 'queued',
    } as unknown as schema.Task;

    const db = makeDb(new Map([[schema.tasks, [foreignTask]]]));
    await expect(requireOwnedTask(db, 'p1', 't1', 'u1')).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});

describe('requireOwnedWorkspace', () => {
  it('returns the workspace when userId matches', async () => {
    const workspace = {
      id: 'w1',
      userId: 'u1',
    } as unknown as schema.Workspace;

    const db = makeDb(new Map([[schema.workspaces, [workspace]]]));
    const result = await requireOwnedWorkspace(db, 'w1', 'u1');
    expect(result).toEqual(workspace);
  });

  it('throws notFound when the workspace belongs to another user', async () => {
    const db = makeDb(new Map([[schema.workspaces, []]]));
    await expect(requireOwnedWorkspace(db, 'w1', 'u1')).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it('throws notFound when DB returns a workspace with mismatched userId', async () => {
    const foreignWorkspace = {
      id: 'w1',
      userId: 'u2',
    } as unknown as schema.Workspace;

    const db = makeDb(new Map([[schema.workspaces, [foreignWorkspace]]]));
    await expect(requireOwnedWorkspace(db, 'w1', 'u1')).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});
