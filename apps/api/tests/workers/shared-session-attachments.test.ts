/**
 * A teammate's prompt with attachments, in a chat shared with them (idea
 * 01M59MYE4GY91BWTE8TZF1ZB5D). Through the real share and prompt routes, real cookies, real R2,
 * the real ProjectData delivery runner and the real delivery adapter; only the VM agent's HTTP
 * is doubled.
 *
 * The files are the teammate's own uploads and go only into the shared chat's workspace, while
 * their grant is active. The delivery fence runs before the transfer and before the send, so a
 * grant that ends first delivers neither the files nor the prompt.
 */
import { buildVmPromptDeliveryCapabilitiesPath } from '@simple-agent-manager/shared';
import { env, runInDurableObject } from 'cloudflare:test';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../src/env';
import { handleAppError } from '../../src/middleware/app-error-handler';
import { requireApproved, requireAuth } from '../../src/middleware/auth';
import { chatRoutes } from '../../src/routes/chat';
import { getNodeBackendBaseUrl } from '../../src/services/node-agent-readiness';
import {
  acceptedPromptResponse,
  versionedPromptCapabilities,
} from '../helpers/vm-prompt-delivery-fixtures';
import { agentOnVm, type Fixture, runDueDelivery } from './helpers/provider-limit-restore';
import { seedSignedInUser, seedUser } from './helpers/seed-d1';

const testEnv = env as unknown as Env;
/** Captured before any test replaces it. */
const passthroughFetch = globalThis.fetch.bind(globalThis);
const RUNTIME_IDENTITY = 'shared-attachments-runtime';
const FILE_TEXT = 'teammate notes';

afterEach(() => {
  if (vi.isMockFunction(globalThis.fetch)) vi.mocked(globalThis.fetch).mockRestore();
});

function app() {
  const root = new Hono<{ Bindings: Env }>();
  root.onError(handleAppError);
  root.use('/api/projects/*', requireAuth(), requireApproved());
  root.route('/api/projects/:projectId/sessions', chatRoutes);
  return root;
}

async function sharedChat() {
  const f = await agentOnVm('conversation');
  // Artifacts-backed, so nothing here reaches GitHub.
  await testEnv.DATABASE.prepare(`UPDATE projects SET repo_provider = 'artifacts' WHERE id = ?`)
    .bind(f.projectId)
    .run();
  const teammate = `teammate-${f.id}`;
  await seedUser(teammate, { name: 'Ana Ruiz' });
  await testEnv.DATABASE.prepare(
    `INSERT INTO project_members (project_id, user_id, role, status, invited_by, created_at, updated_at)
     VALUES (?, ?, 'maintainer', 'active', ?, datetime('now'), datetime('now'))`
  )
    .bind(f.projectId, teammate, f.userId)
    .run();
  const cookies = {
    owner: await seedSignedInUser(f.userId),
    teammate: await seedSignedInUser(teammate),
  };
  const call = (cookie: string, method: string, path: string, body?: unknown) =>
    app().request(
      `/api/projects/${f.projectId}/sessions/${f.chatSessionId}${path}`,
      {
        method,
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
      testEnv
    );
  const shared = await call(cookies.owner, 'POST', '/access/grants', {
    userId: teammate,
    durationMinutes: 30,
    acknowledgeSharedCredentials: true,
  });
  expect(shared.status, await shared.clone().text()).toBe(201);
  return { f, teammate, cookies, call };
}

/** The teammate's own upload, where the upload route stores it: under their own prefix. */
async function uploadAs(userId: string) {
  const uploadId = `upload-${crypto.randomUUID()}`;
  await testEnv.R2.put(`temp-uploads/${userId}/${uploadId}/notes.txt`, FILE_TEXT, {
    httpMetadata: { contentType: 'text/plain' },
  });
  return { uploadId, filename: 'notes.txt', size: FILE_TEXT.length, contentType: 'text/plain' };
}

type Upload = { url: string; destination: string; name: string; text: string };

/** VM agent double for the owner's workspace: capabilities, file uploads and the prompt. */
function installVm(f: Fixture, onUpload?: () => Promise<void>) {
  const uploads: Upload[] = [];
  const prompts: Array<Record<string, unknown>> = [];
  const base = getNodeBackendBaseUrl(f.nodeId, testEnv);
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    if (!request.url.startsWith(base)) return passthroughFetch(input, init);
    const url = new URL(request.url);
    if (url.pathname === buildVmPromptDeliveryCapabilitiesPath(f.workspaceId)) {
      return Response.json({
        ...versionedPromptCapabilities(RUNTIME_IDENTITY),
        sessionRuntimeContract: { supported: true, version: 1 },
      });
    }
    if (url.pathname.endsWith('/files/upload')) {
      const form = await request.formData();
      const file = form.get('files') as File;
      uploads.push({
        url: url.pathname,
        destination: String(form.get('destination')),
        name: file.name,
        text: await file.text(),
      });
      await onUpload?.();
      return Response.json({ ok: true });
    }
    const prompt = /\/agent-sessions\/([^/]+)\/prompt$/.exec(url.pathname);
    if (prompt) {
      const body = JSON.parse(await request.text()) as Record<string, unknown>;
      prompts.push(body);
      return Response.json(
        acceptedPromptResponse(prompt[1]!, String(body.deliveryId), RUNTIME_IDENTITY, Date.now())
      );
    }
    return Response.json({ ok: true });
  });
  return { uploads, prompts };
}

async function inboxRow(f: Fixture, deliveryId: string) {
  return runInDurableObject(f.stub, async (_instance, state) => {
    return state.storage.sql
      .exec(
        `SELECT i.delivery_state, i.last_error, m.tool_metadata
           FROM session_inbox i LEFT JOIN chat_messages m ON m.id = i.prompt_message_id
          WHERE i.id = ?`,
        deliveryId
      )
      .toArray()[0] as {
      delivery_state: string;
      last_error: string | null;
      tool_metadata: string | null;
    };
  });
}

async function expireGrant(f: Fixture, teammate: string) {
  await runInDurableObject(f.stub, async (_instance, state) => {
    state.storage.sql.exec(
      `UPDATE chat_session_access_grants SET expires_at = ?
        WHERE session_id = ? AND grantee_user_id = ? AND revoked_at IS NULL`,
      Date.now() - 1,
      f.chatSessionId,
      teammate
    );
  });
}

describe('a teammate’s attachments in a shared chat', () => {
  it('delivers the teammate’s own files into the shared chat’s workspace, then the prompt', async () => {
    const { f, teammate, cookies, call } = await sharedChat();
    const attachment = await uploadAs(teammate);

    const sent = await call(cookies.teammate, 'POST', '/prompt', {
      content: 'Use these notes',
      attachments: [attachment],
    });
    expect(sent.status, await sent.clone().text()).toBe(202);
    const { deliveryId } = (await sent.json()) as { deliveryId: string };

    const vm = installVm(f);
    const result = await runDueDelivery(f);

    expect(result?.kind).toBe('accepted');
    expect(vm.uploads).toEqual([
      {
        url: `/workspaces/${f.workspaceId}/files/upload`,
        destination: `/workspaces/.private/${attachment.uploadId}`,
        name: 'notes.txt',
        text: FILE_TEXT,
      },
    ]);
    expect(vm.prompts).toHaveLength(1);
    const prompt = String(vm.prompts[0]!.prompt);
    // The agent is told who is speaking, and where the files are.
    expect(prompt).toContain('Ana Ruiz, a project member with shared access to this session');
    expect(prompt).toContain(attachment.uploadId);
    expect((await inboxRow(f, deliveryId)).delivery_state).not.toBe('failed');
  });

  it('refuses another member’s uploads: a prompt can only carry its sender’s own files', async () => {
    const { f, teammate, cookies, call } = await sharedChat();
    // The owner's upload, referenced by the teammate.
    const ownersFile = await uploadAs(f.userId);

    const sent = await call(cookies.teammate, 'POST', '/prompt', {
      content: 'Use the owner’s file',
      attachments: [ownersFile],
    });

    expect(sent.status).toBe(400);
    // Control: the teammate's own upload is accepted.
    const own = await call(cookies.teammate, 'POST', '/prompt', {
      content: 'Use my file',
      attachments: [await uploadAs(teammate)],
    });
    expect(own.status).toBe(202);
  });

  it('delivers neither the files nor the prompt after the grant expires', async () => {
    const { f, teammate, cookies, call } = await sharedChat();
    const sent = await call(cookies.teammate, 'POST', '/prompt', {
      content: 'Use these notes',
      attachments: [await uploadAs(teammate)],
    });
    const { deliveryId } = (await sent.json()) as { deliveryId: string };

    await expireGrant(f, teammate);
    const vm = installVm(f);
    const result = await runDueDelivery(f);

    expect(result).toMatchObject({ kind: 'failed', reason: 'sender_unauthorized' });
    expect(vm.uploads).toEqual([]);
    expect(vm.prompts).toEqual([]);
    const row = await inboxRow(f, deliveryId);
    expect(row.delivery_state).toBe('failed');
    expect(JSON.parse(row.tool_metadata ?? '{}').deliveryCancelled).toBe('sender_access_expired');
  });

  it('stops before the next file and the prompt when access is revoked mid-transfer', async () => {
    const { f, teammate, cookies, call } = await sharedChat();
    const first = await uploadAs(teammate);
    const second = await uploadAs(teammate);
    const sent = await call(cookies.teammate, 'POST', '/prompt', {
      content: 'Use both',
      attachments: [first, second],
    });
    expect(sent.status).toBe(202);

    let revoked = false;
    const vm = installVm(f, async () => {
      if (revoked) return;
      revoked = true;
      // The owner revokes while the first file is being written.
      const response = await call(cookies.owner, 'DELETE', `/access/grants/${teammate}`);
      expect(response.status).toBe(200);
    });
    const result = await runDueDelivery(f);

    expect(result).toMatchObject({ kind: 'failed', reason: 'sender_unauthorized' });
    expect(vm.uploads.map((upload) => upload.destination)).toEqual([
      `/workspaces/.private/${first.uploadId}`,
    ]);
    expect(vm.prompts).toEqual([]);
  });

  it('still delivers the owner’s own attachments', async () => {
    const { f, cookies, call } = await sharedChat();
    const attachment = await uploadAs(f.userId);
    const sent = await call(cookies.owner, 'POST', '/prompt', {
      content: 'My notes',
      attachments: [attachment],
    });
    expect(sent.status).toBe(202);

    const vm = installVm(f);
    expect((await runDueDelivery(f))?.kind).toBe('accepted');
    expect(vm.uploads).toHaveLength(1);
    expect(vm.prompts).toHaveLength(1);
  });
});
