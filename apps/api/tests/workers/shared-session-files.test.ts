/**
 * The Files and Git panels for a teammate a chat is shared with (idea 01M59MYE4GY91BWTE8TZF1ZB5D),
 * through the real share and file routes, real cookies, real D1 and the real ProjectData Durable
 * Object. The VM agent is a double that keeps the real agent's contract: with ?confine=workdir it
 * answers X-SAM-Path-Confinement: workdir (packages/vm-agent/internal/server/file_confinement.go);
 * an "old" double omits it, as an agent built before this change does.
 *
 * A teammate reads the owner's workspace, confined to the repository working tree; nothing is
 * returned unless the agent confirms the confinement; every request re-checks the grant.
 */
import { env, runInDurableObject } from 'cloudflare:test';
import { Hono } from 'hono';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { ProjectData } from '../../src/durable-objects/project-data';
import type { Env } from '../../src/env';
import { handleAppError } from '../../src/middleware/app-error-handler';
import { chatRoutes } from '../../src/routes/chat';
import { projectsRoutes } from '../../src/routes/projects';
import * as projectDataService from '../../src/services/project-data';
import {
  seedInstallation,
  seedNode,
  seedProject,
  seedSignedInUser,
  seedTask,
  seedUser,
  seedWorkspace,
} from './helpers/seed-d1';

const testEnv = env as unknown as Env;
const passthroughFetch = globalThis.fetch.bind(globalThis);
const suffix = crypto.randomUUID();
const OWNER = `files-owner-${suffix}`;
const TEAMMATE = `files-teammate-${suffix}`;
const READER = `files-reader-${suffix}`;
const INSTALLATION = `files-installation-${suffix}`;
const PROJECT = `files-project-${suffix}`;
const cookies: Record<string, string> = {};

afterEach(() => {
  if (vi.isMockFunction(globalThis.fetch)) vi.mocked(globalThis.fetch).mockRestore();
});

function app() {
  const root = new Hono<{ Bindings: Env }>();
  root.onError(handleAppError);
  root.route('/api/projects', projectsRoutes);
  root.route('/api/projects/:projectId/sessions', chatRoutes);
  return root;
}

function call(
  userId: string,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {}
) {
  return app().request(
    `/api/projects/${PROJECT}${path}`,
    {
      method,
      headers: {
        Cookie: cookies[userId]!,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    testEnv
  );
}

type VmCall = { path: string; params: URLSearchParams };

/**
 * VM agent double for one node. `confines` mirrors the real agent's answer to ?confine=workdir;
 * an old agent never sends it. Content is whatever the path asks for, so a leak is visible.
 */
function installVm(nodeId: string, options: { confines: boolean }) {
  const calls: VmCall[] = [];
  const protocol = testEnv.VM_AGENT_PROTOCOL || 'https';
  const port = testEnv.VM_AGENT_PORT || '8443';
  const base = `${protocol}://${nodeId.toLowerCase()}.vm.${testEnv.BASE_DOMAIN}:${port}`;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    if (!request.url.startsWith(base)) return passthroughFetch(input, init);
    const url = new URL(request.url);
    calls.push({ path: url.pathname, params: url.searchParams });
    const headers = new Headers({ 'Content-Type': 'application/json' });
    if (options.confines && url.searchParams.get('confine') === 'workdir') {
      headers.set('X-SAM-Path-Confinement', 'workdir');
    }
    const path = url.searchParams.get('path') ?? '';
    // The real agent answers a matching ETag with 304, confinement header included.
    if (url.pathname.endsWith('/files/raw') && request.headers.get('If-None-Match')) {
      return new Response(null, { status: 304, headers });
    }
    if (url.pathname.endsWith('/git/file')) {
      return new Response(JSON.stringify({ content: `content of ${path}`, filePath: path }), {
        headers,
      });
    }
    if (url.pathname.endsWith('/files/raw') || url.pathname.endsWith('/files/download')) {
      headers.set('Content-Type', 'text/plain');
      return new Response(`bytes of ${path}`, { headers });
    }
    if (url.pathname.endsWith('/files/list')) {
      return new Response(
        JSON.stringify({ path: path || '.', entries: [{ name: 'README.md', type: 'file' }] }),
        { headers }
      );
    }
    if (url.pathname.endsWith('/files/find')) {
      return new Response(JSON.stringify({ files: ['README.md'] }), { headers });
    }
    if (url.pathname.endsWith('/git/status')) {
      return new Response(JSON.stringify({ staged: [], unstaged: [], untracked: [] }), { headers });
    }
    if (url.pathname.endsWith('/git/diff')) {
      return new Response(JSON.stringify({ diff: '', filePath: path }), { headers });
    }
    return new Response(JSON.stringify({ files: [] }), { headers });
  });
  return calls;
}

function stub(): DurableObjectStub<ProjectData> {
  return testEnv.PROJECT_DATA.get(
    testEnv.PROJECT_DATA.idFromName(PROJECT)
  ) as DurableObjectStub<ProjectData>;
}

async function ownerChat(topic: string) {
  const id = crypto.randomUUID();
  const nodeId = `n-${id}`;
  const workspaceId = `w-${id}`;
  const taskId = `t-${id}`;
  await seedNode(nodeId, OWNER);
  const sessionId = await projectDataService.createSession(
    testEnv,
    PROJECT,
    workspaceId,
    topic,
    taskId,
    OWNER
  );
  await seedWorkspace(workspaceId, nodeId, OWNER, { projectId: PROJECT, chatSessionId: sessionId });
  await seedTask(taskId, PROJECT, OWNER, {
    workspaceId,
    chatSessionId: sessionId,
    status: 'in_progress',
  });
  return { sessionId, workspaceId, nodeId };
}

async function share(sessionId: string) {
  const response = await call(OWNER, 'POST', `/sessions/${sessionId}/access/grants`, {
    userId: TEAMMATE,
    durationMinutes: 30,
    acknowledgeSharedCredentials: true,
  });
  expect(response.status, await response.clone().text()).toBe(201);
}

async function expire(sessionId: string) {
  await runInDurableObject(stub(), async (_instance, state) => {
    state.storage.sql.exec(
      `UPDATE chat_session_access_grants SET expires_at = ?
        WHERE session_id = ? AND grantee_user_id = ? AND revoked_at IS NULL`,
      Date.now() - 1,
      sessionId,
      TEAMMATE
    );
  });
}

const READ_ROUTES = [
  { route: 'files/view?path=README.md', vmPath: 'git/file' },
  { route: 'files/list?path=src', vmPath: 'files/list' },
  { route: 'files/find', vmPath: 'files/find' },
  { route: 'git/status', vmPath: 'git/status' },
  { route: 'git/diff?path=README.md', vmPath: 'git/diff' },
  { route: 'files/raw?path=README.md', vmPath: 'files/raw' },
  { route: 'files/download?path=README.md', vmPath: 'files/download' },
] as const;

describe('Files and Git for a teammate in a shared chat', () => {
  beforeAll(async () => {
    for (const userId of [OWNER, TEAMMATE, READER]) {
      await seedUser(userId);
      cookies[userId] = await seedSignedInUser(userId);
    }
    await seedInstallation(INSTALLATION, OWNER);
    await seedProject(PROJECT, OWNER, INSTALLATION);
    await testEnv.DATABASE.prepare(`UPDATE projects SET repo_provider = 'artifacts' WHERE id = ?`)
      .bind(PROJECT)
      .run();
    for (const userId of [TEAMMATE, READER]) {
      await testEnv.DATABASE.prepare(
        `INSERT INTO project_members (project_id, user_id, role, status, invited_by, created_at, updated_at)
         VALUES (?, ?, 'maintainer', 'active', ?, datetime('now'), datetime('now'))`
      )
        .bind(PROJECT, userId, OWNER)
        .run();
    }
  });

  it('serves every read route from the owner’s workspace, confined to the working tree', async () => {
    const chat = await ownerChat('Shared files');
    await share(chat.sessionId);
    const vm = installVm(chat.nodeId, { confines: true });

    for (const { route, vmPath } of READ_ROUTES) {
      const response = await call(TEAMMATE, 'GET', `/sessions/${chat.sessionId}/${route}`);
      expect(response.status, `${route}: ${await response.clone().text()}`).toBe(200);
      const last = vm.at(-1)!;
      expect(last.path).toBe(`/workspaces/${chat.workspaceId}/${vmPath}`);
      expect(last.params.get('confine')).toBe('workdir');
      // The token is signed for this request and never returned.
      expect(last.params.get('token')).toBeTruthy();
      expect(await response.clone().text()).not.toContain(last.params.get('token')!);
    }
    expect(vm).toHaveLength(READ_ROUTES.length);
  });

  it('returns nothing from an agent that does not confirm the confinement', async () => {
    const chat = await ownerChat('Old agent');
    await share(chat.sessionId);
    installVm(chat.nodeId, { confines: false });

    for (const { route } of READ_ROUTES) {
      const response = await call(TEAMMATE, 'GET', `/sessions/${chat.sessionId}/${route}`);
      expect(response.status, route).toBe(409);
      const body = await response.text();
      expect(body).not.toContain('content of');
      expect(body).not.toContain('bytes of');
      expect(body).toContain('older agent');
    }
  });

  it('passes a 304 through only when the agent confirms the confinement', async () => {
    const etag = { 'If-None-Match': '"readme-etag"' };
    const confined = await ownerChat('Cached read');
    await share(confined.sessionId);
    const vm = installVm(confined.nodeId, { confines: true });
    const cached = await call(
      TEAMMATE,
      'GET',
      `/sessions/${confined.sessionId}/files/raw?path=README.md`,
      undefined,
      etag
    );
    expect(cached.status).toBe(304);
    expect(vm.at(-1)!.params.get('confine')).toBe('workdir');

    vi.mocked(globalThis.fetch).mockRestore();
    const old = await ownerChat('Cached read, old agent');
    await share(old.sessionId);
    installVm(old.nodeId, { confines: false });
    const refused = await call(
      TEAMMATE,
      'GET',
      `/sessions/${old.sessionId}/files/raw?path=README.md`,
      undefined,
      etag
    );
    expect(refused.status).toBe(409);
  });

  it('refuses absolute and home paths before reaching the agent', async () => {
    const chat = await ownerChat('Absolute paths');
    await share(chat.sessionId);
    const vm = installVm(chat.nodeId, { confines: true });

    for (const path of ['/etc/passwd', '~/.claude/.credentials.json']) {
      for (const route of ['files/view', 'files/raw', 'files/download', 'files/list', 'git/diff']) {
        const response = await call(
          TEAMMATE,
          'GET',
          `/sessions/${chat.sessionId}/${route}?path=${encodeURIComponent(path)}`
        );
        expect(response.status, `${route} ${path}`).toBe(404);
      }
    }
    expect(vm).toEqual([]);
  });

  it('ends at the next request after the grant expires or is revoked', async () => {
    const expiring = await ownerChat('Expiry');
    await share(expiring.sessionId);
    const vm = installVm(expiring.nodeId, { confines: true });
    expect(
      (await call(TEAMMATE, 'GET', `/sessions/${expiring.sessionId}/files/view?path=README.md`))
        .status
    ).toBe(200);

    await expire(expiring.sessionId);
    for (const { route } of READ_ROUTES) {
      const response = await call(TEAMMATE, 'GET', `/sessions/${expiring.sessionId}/${route}`);
      expect(response.status, route).toBe(403);
    }
    expect(vm).toHaveLength(1);

    vi.mocked(globalThis.fetch).mockRestore();
    const revoked = await ownerChat('Revoke');
    await share(revoked.sessionId);
    const vm2 = installVm(revoked.nodeId, { confines: true });
    expect((await call(TEAMMATE, 'GET', `/sessions/${revoked.sessionId}/git/status`)).status).toBe(
      200
    );
    const removed = await call(
      OWNER,
      'DELETE',
      `/sessions/${revoked.sessionId}/access/grants/${TEAMMATE}`
    );
    expect(removed.status).toBe(200);
    expect((await call(TEAMMATE, 'GET', `/sessions/${revoked.sessionId}/git/status`)).status).toBe(
      403
    );
    expect(vm2).toHaveLength(1);
  });

  it('refuses a member the chat is not shared with', async () => {
    const chat = await ownerChat('Not shared');
    const vm = installVm(chat.nodeId, { confines: true });

    for (const { route } of READ_ROUTES) {
      const response = await call(READER, 'GET', `/sessions/${chat.sessionId}/${route}`);
      expect(response.status, route).toBe(403);
      // The refusal names what was asked for.
      expect(await response.text(), route).toContain(
        route.startsWith('git/') ? 'review changes in this session' : 'read files in this session'
      );
    }
    expect(vm).toEqual([]);
  });

  it('keeps upload with the owner', async () => {
    const chat = await ownerChat('Upload');
    await share(chat.sessionId);
    const vm = installVm(chat.nodeId, { confines: true });
    const form = new FormData();
    form.append('files', new Blob(['x']), 'x.txt');

    const response = await app().request(
      `/api/projects/${PROJECT}/sessions/${chat.sessionId}/files/upload`,
      { method: 'POST', headers: { Cookie: cookies[TEAMMATE]! }, body: form },
      testEnv
    );

    expect(response.status).toBe(404);
    expect(vm).toEqual([]);
  });

  it('leaves the owner’s reads unchanged, including chats from before owners were recorded', async () => {
    const chat = await ownerChat('Owner');
    await share(chat.sessionId);
    const vm = installVm(chat.nodeId, { confines: true });

    const absolute = await call(
      OWNER,
      'GET',
      `/sessions/${chat.sessionId}/files/view?path=/etc/hostname`
    );
    expect(absolute.status).toBe(200);
    expect(vm.at(-1)!.params.get('confine')).toBeNull();

    await runInDurableObject(stub(), async (_instance, state) => {
      state.storage.sql.exec(
        'UPDATE chat_sessions SET created_by_user_id = NULL WHERE id = ?',
        chat.sessionId
      );
    });
    const legacy = await call(OWNER, 'GET', `/sessions/${chat.sessionId}/git/status`);
    expect(legacy.status).toBe(200);
    expect(vm.at(-1)!.params.get('confine')).toBeNull();
    expect(vm).toHaveLength(2);
  });

  it('never lets a teammate past the grant into another chat’s workspace', async () => {
    const shared = await ownerChat('Shared one');
    const other = await ownerChat('Not shared one');
    await share(shared.sessionId);
    const vm = installVm(other.nodeId, { confines: true });

    const response = await call(TEAMMATE, 'GET', `/sessions/${other.sessionId}/git/status`);
    expect(response.status).toBe(403);
    expect(vm).toEqual([]);
  });

  it('reads only the chat owner’s workspace, never another member’s linked to the chat', async () => {
    // A chat the owner shared, linked in D1 to a workspace that belongs to someone else.
    const chat = await ownerChat('Mismatched link');
    await share(chat.sessionId);
    const foreignNode = `n-foreign-${crypto.randomUUID()}`;
    await seedNode(foreignNode, READER);
    await testEnv.DATABASE.prepare('UPDATE workspaces SET chat_session_id = NULL WHERE id = ?')
      .bind(chat.workspaceId)
      .run();
    await seedWorkspace(`w-foreign-${crypto.randomUUID()}`, foreignNode, READER, {
      projectId: PROJECT,
      chatSessionId: chat.sessionId,
    });
    const vm = installVm(foreignNode, { confines: true });

    const response = await call(TEAMMATE, 'GET', `/sessions/${chat.sessionId}/git/status`);

    expect(response.status).toBe(404);
    expect(vm).toEqual([]);
  });
});
