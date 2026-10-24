import { env, SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';

import type { Env } from '../../src/env';
import type { OperationError } from '../../src/operations/errors';
import {
  addIdeaUpdate,
  deleteIdeaUpdate,
  listIdeaUpdates,
} from '../../src/operations/idea-update-core';
import { samIdeaUpdate, samIdeaUpdatesList } from '../../src/operations/platform-operations';
import type { OperationContext } from '../../src/operations/types';
import { handleUpdateIdea } from '../../src/routes/mcp/idea-tools';
import { CONNECTOR_DEFAULTS } from '../../src/services/connector-settings';
import type { McpTokenData } from '../../src/services/mcp-token';
import {
  seedAgentSession,
  seedInstallation,
  seedProject,
  seedSignedInUser,
  seedTask,
  seedUser,
  seedWorkspace,
} from './helpers/seed-d1';

const suffix = crypto.randomUUID();
const owner = `idea-owner-${suffix}`;
const member = `idea-member-${suffix}`;
const viewer = `idea-viewer-${suffix}`;
const outsider = `idea-outsider-${suffix}`;
const project = `idea-project-${suffix}`;
const foreignProject = `idea-foreign-${suffix}`;
const idea = `idea-${suffix}`;
const foreignIdea = `foreign-idea-${suffix}`;
const ordinaryTask = `ordinary-task-${suffix}`;
const readyTask = `ready-task-${suffix}`;
const workspace = `idea-workspace-${suffix}`;
const session = `idea-session-${suffix}`;
const agentSession = `idea-agent-${suffix}`;
const testEnv = env as unknown as Env;
const ownerContext: OperationContext = {
  env: testEnv,
  requestId: 'test',
  actor: { userId: owner, via: 'web', scopes: new Set(['sam.read', 'sam.write']) },
};
const memberContext: OperationContext = {
  env: testEnv,
  requestId: 'test',
  actor: { userId: member, via: 'web', scopes: new Set(['sam.read', 'sam.write']) },
};

beforeAll(async () => {
  await seedUser(owner);
  await seedUser(member);
  await seedUser(viewer);
  await seedUser(outsider);
  await seedInstallation(`idea-install-${suffix}`, owner);
  await seedProject(project, owner, `idea-install-${suffix}`);
  await seedProject(foreignProject, owner, `idea-install-${suffix}`);
  await env.DATABASE.prepare(
    "INSERT INTO project_members (project_id, user_id, role, status, created_at, updated_at) VALUES (?, ?, 'maintainer', 'active', datetime('now'), datetime('now'))"
  )
    .bind(project, member)
    .run();
  await env.DATABASE.prepare(
    "INSERT INTO project_members (project_id, user_id, role, status, created_at, updated_at) VALUES (?, ?, 'viewer', 'active', datetime('now'), datetime('now'))"
  )
    .bind(project, viewer)
    .run();
  await seedTask(idea, project, owner, { status: 'draft' });
  await seedTask(foreignIdea, foreignProject, owner, { status: 'draft' });
  await seedTask(ordinaryTask, project, owner, { status: 'delegated' });
  await seedTask(readyTask, project, owner, { status: 'ready' });
  await env.DATABASE.prepare('UPDATE tasks SET description = ? WHERE id = ?')
    .bind('Current plan', idea)
    .run();
  await seedWorkspace(workspace, null, owner, { projectId: project, chatSessionId: session });
  await seedAgentSession(agentSession, workspace, owner, { agentType: 'codex' });
});

describe('idea updates through real D1 and ProjectData SQLite', () => {
  it('rejects a foreign-project idea and allows the same owner in its actual project', async () => {
    await expect(
      addIdeaUpdate(ownerContext, { projectId: project, ideaId: foreignIdea, body: 'attack' })
    ).rejects.toMatchObject({ code: 'not_found' } satisfies Partial<OperationError>);
    const created = await addIdeaUpdate(ownerContext, {
      projectId: foreignProject,
      ideaId: foreignIdea,
      body: 'owner control',
    });
    expect(created.update.body).toBe('owner control');
  });

  it('does not attach notes to ordinary tasks', async () => {
    await expect(
      addIdeaUpdate(ownerContext, { projectId: project, ideaId: ordinaryTask, body: 'not an idea' })
    ).rejects.toMatchObject({ code: 'not_found' } satisfies Partial<OperationError>);
    await expect(
      addIdeaUpdate(ownerContext, { projectId: project, ideaId: readyTask, body: 'not an idea' })
    ).rejects.toMatchObject({ code: 'not_found' } satisfies Partial<OperationError>);
  });

  it('pages newest first, soft deletes, and limits delete to author or project admin', async () => {
    const deleteIdea = `delete-idea-${suffix}`;
    await seedTask(deleteIdea, project, owner, { status: 'draft' });
    const first = await addIdeaUpdate(ownerContext, {
      projectId: project,
      ideaId: deleteIdea,
      body: 'first',
    });
    const second = await addIdeaUpdate(memberContext, {
      projectId: project,
      ideaId: deleteIdea,
      body: 'second',
    });
    await expect(
      deleteIdeaUpdate(memberContext, {
        projectId: project,
        ideaId: deleteIdea,
        updateId: first.update.id,
      })
    ).rejects.toMatchObject({ code: 'not_found' } satisfies Partial<OperationError>);
    const page = await listIdeaUpdates(ownerContext, { projectId: project, ideaId: deleteIdea });
    expect(page.updates.map((item) => item.id)).toEqual([second.update.id, first.update.id]);
    await deleteIdeaUpdate(ownerContext, {
      projectId: project,
      ideaId: deleteIdea,
      updateId: second.update.id,
    });
    await deleteIdeaUpdate(ownerContext, {
      projectId: project,
      ideaId: deleteIdea,
      updateId: first.update.id,
    });
    expect(
      (await listIdeaUpdates(ownerContext, { projectId: project, ideaId: deleteIdea })).updates
    ).toHaveLength(0);
  });

  it('returns a stable cursor across multiple pages', async () => {
    const pageIdea = `page-idea-${suffix}`;
    await seedTask(pageIdea, project, owner, { status: 'draft' });
    const inserted = [];
    for (let i = 0; i < 32; i++) {
      inserted.push(
        (
          await addIdeaUpdate(ownerContext, {
            projectId: project,
            ideaId: pageIdea,
            body: `page ${i}`,
          })
        ).update.id
      );
    }
    const first = await listIdeaUpdates(ownerContext, { projectId: project, ideaId: pageIdea });
    expect(first.updates).toHaveLength(30);
    expect(first.nextCursor).toBeTruthy();
    const second = await listIdeaUpdates(ownerContext, {
      projectId: project,
      ideaId: pageIdea,
      cursor: first.nextCursor!,
    });
    expect(second.updates.map((item) => item.id)).toEqual(inserted.slice(0, 2).reverse());
    expect(second.nextCursor).toBeNull();
  });

  it('serves add, list and delete through authenticated REST routes', async () => {
    const cookie = await seedSignedInUser(owner);
    const url = `https://api.example.test/api/projects/${project}/ideas/${idea}/updates`;
    const posted = await SELF.fetch(url, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: 'REST progress' }),
    });
    expect(posted.status).toBe(201);
    const created = await posted.json<{ update: { id: string; authorName: string | null } }>();
    expect(created.update.authorName).toBe('Test User');
    const listed = await SELF.fetch(url, { headers: { Cookie: cookie } });
    expect(listed.status).toBe(200);
    expect(
      (await listed.json<{ updates: Array<{ id: string }> }>()).updates.some(
        (update) => update.id === created.update.id
      )
    ).toBe(true);
    const deleted = await SELF.fetch(`${url}/${created.update.id}`, {
      method: 'DELETE',
      headers: { Cookie: cookie },
    });
    expect(deleted.status).toBe(200);
  });

  it('rejects REST writes by a viewer and foreign-project idea IDs', async () => {
    const viewerCookie = await seedSignedInUser(viewer);
    const ownerCookie = await seedSignedInUser(owner);
    const base = `https://api.example.test/api/projects/${project}/ideas`;
    const headers = { 'Content-Type': 'application/json' };
    const viewerPost = await SELF.fetch(`${base}/${idea}/updates`, {
      method: 'POST',
      headers: { ...headers, Cookie: viewerCookie },
      body: JSON.stringify({ body: 'unauthorized' }),
    });
    expect(viewerPost.status).toBe(403);
    const foreignPost = await SELF.fetch(`${base}/${foreignIdea}/updates`, {
      method: 'POST',
      headers: { ...headers, Cookie: ownerCookie },
      body: JSON.stringify({ body: 'wrong project' }),
    });
    expect(foreignPost.status).toBe(404);
  });

  it('requires authentication and project membership through the combined routes app', async () => {
    const url = `https://api.example.test/api/projects/${project}/ideas/${idea}/updates`;
    const unauthenticated = await SELF.fetch(url);
    expect(unauthenticated.status).toBe(401);

    const outsiderCookie = await seedSignedInUser(outsider);
    const outsiderRead = await SELF.fetch(url, { headers: { Cookie: outsiderCookie } });
    expect(outsiderRead.status).toBe(404);
    const outsiderWrite = await SELF.fetch(url, {
      method: 'POST',
      headers: { Cookie: outsiderCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: 'outsider note' }),
    });
    expect(outsiderWrite.status).toBe(404);
  });

  it('enforces body and quote caps and sanitizes input before storage', async () => {
    await expect(
      addIdeaUpdate(ownerContext, { projectId: project, ideaId: idea, body: 'x'.repeat(8_001) })
    ).rejects.toMatchObject({ code: 'invalid_input' } satisfies Partial<OperationError>);
    await expect(
      addIdeaUpdate(ownerContext, {
        projectId: project,
        ideaId: idea,
        body: 'short',
        quote: 'x'.repeat(1_001),
      })
    ).rejects.toMatchObject({ code: 'invalid_input' } satisfies Partial<OperationError>);
    const accepted = await addIdeaUpdate(ownerContext, {
      projectId: project,
      ideaId: idea,
      body: '  useful\u0000 note  ',
    });
    expect(accepted.update.body).toBe('useful note');
  });

  it('exposes note writes and lists through connector operations', async () => {
    const connectorIdea = `connector-idea-${suffix}`;
    await seedTask(connectorIdea, project, owner, { status: 'draft' });
    const connectorContext: OperationContext = {
      env: testEnv,
      requestId: 'connector-test',
      actor: { userId: owner, via: 'connector', scopes: new Set(['sam.read', 'sam.write']) },
      connectorSettings: CONNECTOR_DEFAULTS,
    };
    const written = await samIdeaUpdate.run(connectorContext, {
      projectId: project,
      ideaId: connectorIdea,
      note: 'Connector note',
    });
    expect(written.note?.body).toBe('Connector note');
    const listed = await samIdeaUpdatesList.run(connectorContext, {
      projectId: project,
      ideaId: connectorIdea,
    });
    expect(listed.updates.map((note) => note.id)).toContain(written.note?.id);
    expect(listed.untrustedContent).toBe(true);
  });

  it('real update_idea handler posts an agent note without changing the plan and throttles a loop', async () => {
    const token: McpTokenData = {
      taskId: idea,
      projectId: project,
      userId: owner,
      workspaceId: workspace,
      agentSessionId: agentSession,
      createdAt: new Date().toISOString(),
    };
    const result = await handleUpdateIdea(
      'note-one',
      { ideaId: idea, note: 'Agent finding', quote: 'Current plan' },
      token,
      testEnv
    );
    expect(result.error).toBeUndefined();
    const page = await listIdeaUpdates(ownerContext, { projectId: project, ideaId: idea });
    expect(page.updates[0]).toMatchObject({
      body: 'Agent finding',
      quote: 'Current plan',
      sessionId: session,
      authorKind: 'agent',
      authorName: 'codex',
    });
    const row = await env.DATABASE.prepare(
      'SELECT description FROM tasks WHERE id = ? AND project_id = ?'
    )
      .bind(idea, project)
      .first<{ description: string }>();
    expect(row?.description).toBe('Current plan');
    const repeated = await handleUpdateIdea(
      'note-two',
      { ideaId: idea, note: 'Loop' },
      token,
      testEnv
    );
    expect(repeated.error).toBeDefined();
    const combined = await handleUpdateIdea(
      'combined',
      { ideaId: idea, note: 'Will not post', content: 'Will not append' },
      token,
      testEnv
    );
    expect(combined.error).toBeDefined();
    const after = await env.DATABASE.prepare('SELECT description FROM tasks WHERE id = ?')
      .bind(idea)
      .first<{ description: string }>();
    expect(after?.description).toBe('Current plan');
  });
});
