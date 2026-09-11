/**
 * project-auth middleware — behavioral tests.
 *
 * These helpers are IDOR boundaries for project-scoped routes. Tests construct
 * mismatched rows directly so a weakened query or bad stub cannot bypass the
 * explicit defense-in-depth checks.
 */
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { AppDb } from '../../../src/middleware/project-auth';
import {
  createOwnerProjectMembership,
  requireOwnedProject,
  requireOwnedWorkspace,
  requireProjectAccess,
  requireProjectCapability,
} from '../../../src/middleware/project-auth';
import { createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

/**
 * Row-injecting stub. Its ONLY job is the defence-in-depth cases: handing the guards a row
 * that a correct WHERE clause would never return, so the explicit post-query assertions are
 * proven to reject it. It deliberately ignores predicates, so it can NOT prove the SQL
 * filters — see the real-SQL-engine block at the bottom of this file for that
 * (`.claude/rules/28`).
 *
 * Each `select()` gets its own chain so two queries built before either is awaited keep
 * their own table identity.
 */
function makeDb(dataByTable: Map<unknown, unknown[]>): AppDb {
  const makeChain = () => {
    let currentTable: unknown = null;
    const chain = {
      from: (table: unknown) => {
        currentTable = table;
        return chain;
      },
      where: () => chain,
      limit: () => Promise.resolve(dataByTable.get(currentTable) ?? []),
    };
    return chain;
  };

  return { select: () => makeChain() } as unknown as AppDb;
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
  it.each(['admin', 'maintainer'] as const)('allows active %s members to use task:write on owner-created project tasks', async (role) => {
    const project = makeProject({ userId: 'owner-user' });
    const member = makeMember({ userId: 'member-user', role });
    const db = makeDb(new Map([[schema.projects, [project]], [schema.projectMembers, [member]]]));

    const result = await requireProjectCapability(db, 'p1', 'member-user', 'task:write');

    expect(result).toEqual(project);
  });

  it('returns notFound for task:write when the caller is not an active project member', async () => {
    const project = makeProject({ userId: 'owner-user' });
    const db = makeDb(new Map([[schema.projects, [project]], [schema.projectMembers, []]]));

    await expect(requireProjectCapability(db, 'p1', 'nonmember-user', 'task:write')).rejects.toMatchObject({
      statusCode: 404,
      error: 'NOT_FOUND',
    });
  });

  it('returns notFound for task:write when the caller membership is suspended', async () => {
    const project = makeProject({ userId: 'owner-user' });
    const member = makeMember({ userId: 'member-user', role: 'maintainer', status: 'suspended' });
    const db = makeDb(new Map([[schema.projects, [project]], [schema.projectMembers, [member]]]));

    await expect(requireProjectCapability(db, 'p1', 'member-user', 'task:write')).rejects.toMatchObject({
      statusCode: 404,
      error: 'NOT_FOUND',
    });
  });

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

  it('reserves ownership transfer for owners', async () => {
    const project = makeProject({ userId: 'owner-user' });
    const ownerDb = makeDb(
      new Map([
        [schema.projects, [project]],
        [schema.projectMembers, [makeMember({ userId: 'owner-user', role: 'owner' })]],
      ])
    );
    const adminDb = makeDb(
      new Map([
        [schema.projects, [project]],
        [schema.projectMembers, [makeMember({ userId: 'admin-user', role: 'admin' })]],
      ])
    );

    await expect(
      requireProjectCapability(ownerDb, 'p1', 'owner-user', 'project:transfer_ownership')
    ).resolves.toEqual(project);
    await expect(
      requireProjectCapability(adminDb, 'p1', 'admin-user', 'project:transfer_ownership')
    ).rejects.toMatchObject({
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

/**
 * The guards above are SQL predicates, so `.claude/rules/28` requires them to be exercised
 * against a real SQL engine with an owner-path control beside every refusal — a stub whose
 * `.where()` ignores its arguments passes identically with the predicate deleted.
 *
 * It matters more now that these lookups run inside a request-scoped D1 session: the second
 * select is served by a replica anchored at the first query's bookmark rather than by the
 * primary, so the predicates need coverage that does not depend on which instance answered.
 */
describe('requireActiveProjectMembership against a real SQL engine', () => {
  const NOW = '2026-09-11T00:00:00.000Z';
  const PROJECT_A = 'proj-a';
  const PROJECT_B = 'proj-b';

  function seed(): { db: AppDb; sqlite: Database.Database } {
    const sqlite = new Database(':memory:');
    createSchemaTables(sqlite, [schema.projects, schema.projectMembers]);
    sqlite
      .prepare('INSERT INTO projects (id, user_id, name) VALUES (?, ?, ?), (?, ?, ?)')
      .run(PROJECT_A, 'owner-a', 'Project A', PROJECT_B, 'owner-b', 'Project B');
    const insertMember = sqlite.prepare(
      `INSERT INTO project_members (project_id, user_id, role, status, invited_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, ?, ?)`
    );
    insertMember.run(PROJECT_A, 'owner-a', 'owner', 'active', NOW, NOW);
    insertMember.run(PROJECT_A, 'viewer-a', 'viewer', 'active', NOW, NOW);
    insertMember.run(PROJECT_A, 'suspended-a', 'maintainer', 'suspended', NOW, NOW);
    insertMember.run(PROJECT_B, 'owner-b', 'owner', 'active', NOW, NOW);
    return { db: drizzle(createSqliteD1(sqlite), { schema }) as unknown as AppDb, sqlite };
  }

  it('returns the project for an active member (owner-path control)', async () => {
    const { db } = seed();
    await expect(requireProjectAccess(db, PROJECT_A, 'viewer-a')).resolves.toMatchObject({
      id: PROJECT_A,
      userId: 'owner-a',
    });
  });

  it('refuses a member of a DIFFERENT project addressed at this project', async () => {
    const { db } = seed();
    await expect(requireProjectAccess(db, PROJECT_A, 'owner-b')).rejects.toMatchObject({
      statusCode: 404,
      error: 'NOT_FOUND',
    });
    // Owner control beside the refusal: the same fixture still admits project B's owner.
    await expect(requireProjectAccess(db, PROJECT_B, 'owner-b')).resolves.toMatchObject({
      id: PROJECT_B,
    });
  });

  it('refuses a suspended membership and does NOT fall through to the project row', async () => {
    const { db } = seed();
    await expect(requireProjectAccess(db, PROJECT_A, 'suspended-a')).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(requireProjectAccess(db, PROJECT_A, 'owner-a')).resolves.toMatchObject({
      id: PROJECT_A,
    });
  });

  it('refuses a user with no membership row at all', async () => {
    const { db } = seed();
    await expect(requireProjectAccess(db, PROJECT_A, 'stranger')).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it('refuses when the project id does not exist, even for a real user', async () => {
    const { db } = seed();
    await expect(requireProjectAccess(db, 'proj-missing', 'owner-a')).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it('enforces role capabilities on rows the predicates actually returned', async () => {
    const { db } = seed();
    await expect(
      requireProjectCapability(db, PROJECT_A, 'viewer-a', 'project:read')
    ).resolves.toMatchObject({ id: PROJECT_A });
    await expect(
      requireProjectCapability(db, PROJECT_A, 'viewer-a', 'task:write')
    ).rejects.toMatchObject({ statusCode: 403, error: 'FORBIDDEN' });
    await expect(
      requireProjectCapability(db, PROJECT_A, 'owner-a', 'task:write')
    ).resolves.toMatchObject({ id: PROJECT_A });
  });
});
