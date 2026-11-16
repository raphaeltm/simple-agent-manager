/**
 * Shared harness for the inbox capability tests (`inbox-capability.test.ts`, slices A and G, and
 * `inbox-agent-tools-capability.test.ts`, slice D): one project with an owner and a colleague, a
 * running task chat with an agent token, the real inbox routes behind the real auth middleware,
 * and helpers to call the real `/mcp` route. `fetchMock` stubs the VM agent HTTP edge.
 */
import type { ProjectData } from '@simple-agent-manager/project-data/internal/do/index';
import { env, SELF } from 'cloudflare:test';
import { Hono } from 'hono';
import { expect, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { handleAppError } from '../../../src/middleware/app-error-handler';
import { requireApproved, requireAuth } from '../../../src/middleware/auth';
import { inboxRoutes, projectInboxRoutes } from '../../../src/routes/inbox';
import { projectInboxTaskRoutes } from '../../../src/routes/inbox-tasks';
import { projectCommentRoutes } from '../../../src/routes/project-comments';
import { storeMcpToken } from '../../../src/services/mcp-token';
import {
  seedAgentSession,
  seedInstallation,
  seedNode,
  seedProject,
  seedSignedInUser,
  seedTask,
  seedUser,
  seedWorkspace,
} from './seed-d1';

export const testEnv = env as unknown as Env;
export const ORIGIN = `https://app.${testEnv.BASE_DOMAIN}`;
export const fetchMock = vi.fn<typeof fetch>();

export function browserApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.onError(handleAppError);
  app.use('/api/*', requireAuth(), requireApproved());
  app.route('/api/inbox', inboxRoutes);
  app.route('/api/projects/:projectId/inbox', projectInboxRoutes);
  app.route('/api/projects/:projectId/inbox', projectInboxTaskRoutes);
  app.route('/api/projects/:projectId/comments', projectCommentRoutes);
  return app;
}

export interface Seeded {
  projectId: string;
  ownerId: string;
  colleagueId: string;
  ownerCookie: string;
  colleagueCookie: string;
  chatSessionId: string;
  colleagueSessionId: string;
  workspaceId: string;
  agentSessionId: string;
  taskId: string;
  token: string;
  project: DurableObjectStub<ProjectData>;
}

export async function seed(): Promise<Seeded> {
  const suffix = crypto.randomUUID().slice(0, 8);
  const ownerId = `inbox-owner-${suffix}`;
  const colleagueId = `inbox-colleague-${suffix}`;
  const installationId = `inbox-install-${suffix}`;
  const projectId = `inbox-project-${suffix}`;
  const nodeId = `inbox-node-${suffix}`;
  const workspaceId = `inbox-ws-${suffix}`;
  const agentSessionId = `inbox-agent-${suffix}`;
  const taskId = `inbox-task-${suffix}`;
  await seedUser(ownerId, { githubId: `gh-${ownerId}` });
  await seedUser(colleagueId, { githubId: `gh-${colleagueId}` });
  await seedInstallation(installationId, ownerId, { installationIdValue: `inst-${suffix}` });
  await seedProject(projectId, ownerId, installationId);
  await testEnv.DATABASE.prepare(
    `INSERT INTO project_members (project_id, user_id, role, status) VALUES (?, ?, 'maintainer', 'active')`
  )
    .bind(projectId, colleagueId)
    .run();
  await seedNode(nodeId, ownerId);
  const project = testEnv.PROJECT_DATA.get(
    testEnv.PROJECT_DATA.idFromName(projectId)
  ) as DurableObjectStub<ProjectData>;
  await project.ensureProjectId(projectId);
  const chatSessionId = await project.createSession(workspaceId, 'Inbox chat', taskId, ownerId);
  const colleagueSessionId = await project.createSession(
    null,
    'Colleague private chat',
    null,
    colleagueId
  );
  await seedWorkspace(workspaceId, nodeId, ownerId, {
    projectId,
    chatSessionId,
    status: 'running',
  });
  await seedTask(taskId, projectId, ownerId, {
    title: 'Inbox task',
    status: 'in_progress',
    taskMode: 'task',
    chatSessionId,
  });
  await seedAgentSession(agentSessionId, workspaceId, ownerId, { status: 'running' });
  const token = `inbox-token-${suffix}`;
  await storeMcpToken(testEnv.KV, token, {
    taskId,
    taskMode: 'task',
    projectId,
    userId: ownerId,
    workspaceId,
    chatSessionId,
    agentSessionId,
    createdAt: new Date().toISOString(),
  });
  return {
    projectId,
    ownerId,
    colleagueId,
    ownerCookie: await seedSignedInUser(ownerId),
    colleagueCookie: await seedSignedInUser(colleagueId),
    chatSessionId,
    colleagueSessionId,
    workspaceId,
    agentSessionId,
    taskId,
    token,
    project,
  };
}

export async function callTool(token: string, name: string, args: Record<string, unknown>) {
  const response = await SELF.fetch(`https://api.${testEnv.BASE_DOMAIN}/mcp`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: `${name}-1`,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  });
  expect(response.status).toBe(200);
  const body = await response.json<{
    error?: unknown;
    result?: { content?: { text: string }[] };
  }>();
  expect(body.error).toBeUndefined();
  return JSON.parse(body.result?.content?.[0]?.text ?? '{}') as Record<string, unknown>;
}

export async function get<T>(path: string, cookie: string): Promise<{ status: number; body: T }> {
  const response = await browserApp().request(path, { headers: { Cookie: cookie } }, testEnv);
  return { status: response.status, body: (await response.json()) as T };
}

export async function post(path: string, cookie: string, body: unknown = {}) {
  const response = await browserApp().request(
    path,
    {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json', Origin: ORIGIN },
      body: JSON.stringify(body),
    },
    testEnv
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}
