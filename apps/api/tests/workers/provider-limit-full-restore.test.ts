/** Full limit recovery with real callback auth, D1, DOs, R2 and every TaskRunner step.
 * The only fault peer is this test's VM HTTP double; release builds have no switch. */
import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';

import recorded from '../../../../tests/fixtures/provider-limit-rejections.json';
import { runSessionSleepSweep } from '../../src/scheduled/session-sleep';
import { signCallbackToken } from '../../src/services/jwt';
import { getNodeBackendBaseUrl } from '../../src/services/node-agent-readiness';
import {
  parseProviderLimitWait,
  PROVIDER_LIMIT_CONTINUATION,
} from '../../src/services/provider-limit-policy';
import { buildSessionSnapshotR2Key } from '../../src/services/session-snapshots';
import {
  acceptedPromptResponse,
  versionedPromptCapabilities,
} from '../helpers/vm-prompt-delivery-fixtures';
import { sqlRows, testEnv } from './helpers/agent-message-channels';
import {
  agentOnVm,
  deleteSleptWorkspace,
  driveMove,
  type Fixture,
  readyReplacementNode,
  runDueDelivery,
  taskRow,
  taskRunner,
  waitForWakeReadiness,
} from './helpers/provider-limit-restore';

declare const __PROVIDER_LIMIT_CALLBACKS__: Array<{
  name: string;
  callback: Record<string, unknown>;
}> | null;
const callbackCases = __PROVIDER_LIMIT_CALLBACKS__ ?? recorded.cases;

const nativeFetch = globalThis.fetch.bind(globalThis);
const runtimeIdentity = 'provider-restored-runtime';
afterEach(() => {
  if (vi.isMockFunction(globalThis.fetch)) vi.mocked(globalThis.fetch).mockRestore();
  vi.useRealTimers();
});

async function snapshot(f: Fixture, token: string) {
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const base = `https://api.test.example.com/api/workspaces/${f.workspaceId}/session-snapshot`;
  const prepared = await SELF.fetch(`${base}/prepare`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      chatSessionId: f.chatSessionId,
      agentSessionId: `a-${f.id}`,
      runtime: 'vm',
    }),
  });
  expect(prepared.status, await prepared.clone().text()).toBe(200);
  const { generation } = await prepared.json<{ generation: string }>();
  const home = new TextEncoder().encode('test-only saved harness');
  const digest = await crypto.subtle.digest('SHA-256', home);
  const sha256 = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join(
    ''
  );
  await env.R2.put(buildSessionSnapshotR2Key(testEnv, f.chatSessionId, generation, 'home'), home, {
    sha256: digest,
  });
  const completed = await SELF.fetch(`${base}/complete`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      chatSessionId: f.chatSessionId,
      generation,
      agentSessionId: `a-${f.id}`,
      runtime: 'vm',
      status: 'available',
      degradation: 'none',
      manifest: {
        version: 1,
        chatSessionId: f.chatSessionId,
        workspaceId: f.workspaceId,
        agentSessionId: `a-${f.id}`,
        acpSessionId: 'saved-harness',
        agentType: f.agentType,
        status: 'available',
        degradation: 'none',
        skipped: [],
        artifacts: { home: { sizeBytes: home.byteLength, sha256 } },
        createdAt: new Date().toISOString(),
      },
    }),
  });
  expect(completed.status, await completed.text()).toBe(200);
}

function vmPeer(f: Fixture, replacementNode: string, restoreFailure: boolean) {
  const original = getNodeBackendBaseUrl(f.nodeId, testEnv);
  const replacement = getNodeBackendBaseUrl(replacementNode, testEnv);
  const tokens = new Map<string, string>();
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    if (!request.url.startsWith(original) && !request.url.startsWith(replacement))
      return nativeFetch(input, init);
    const path = new URL(request.url).pathname;
    const text = typeof init?.body === 'string' ? init.body : await request.clone().text();
    const body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    calls.push({ path, body });
    if (path.endsWith('/hibernate')) {
      await snapshot(f, String(body.workspaceCallbackToken));
      return Response.json({ status: 'pending', accepted: true });
    }
    if (path === '/workspaces' && request.method === 'POST') {
      tokens.set(String(body.workspaceId), String(body.callbackToken));
      const response = await SELF.fetch(
        `https://api.test.example.com/api/workspaces/${body.workspaceId}/ready`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${body.callbackToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ status: 'running' }),
        }
      );
      expect(response.status, await response.text()).toBe(200);
      return Response.json({ workspaceId: body.workspaceId }, { status: 202 });
    }
    if (path.endsWith('/agent-capabilities'))
      return Response.json({
        ...versionedPromptCapabilities(runtimeIdentity),
        sessionRuntimeContract: { supported: true, version: 1 },
      });
    if (path.endsWith('/restore')) {
      expect(body.runtimeContract).toEqual(f.contract);
      const workspaceId = path.split('/')[2]!;
      const response = await SELF.fetch(
        `https://api.test.example.com/api/workspaces/${workspaceId}/session-snapshot/restore?chatSessionId=${f.chatSessionId}`,
        { headers: { Authorization: `Bearer ${tokens.get(workspaceId)}` } }
      );
      expect(response.status, await response.clone().text()).toBe(200);
      expect(await response.json()).toMatchObject({
        available: true,
        manifest: { acpSessionId: 'saved-harness', agentType: f.agentType },
      });
      return Response.json({ status: restoreFailure ? 'failed' : 'restored' });
    }
    if (path.endsWith('/start')) {
      const workspaceId = path.split('/')[2]!;
      const agentSessionId = path.split('/')[4]!;
      expect(body.agentType).toBe(f.agentType);
      expect(body.model ?? null).toBe(f.contract.model);
      const injected = await SELF.fetch(
        `https://api.test.example.com/api/workspaces/${workspaceId}/agent-key`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${tokens.get(workspaceId)}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ agentType: f.agentType, agentSessionId }),
        }
      );
      expect(injected.status, await injected.clone().text()).toBe(200);
      expect(
        await env.DATABASE.prepare(
          'SELECT agent_credential_reference,agent_profile_id FROM agent_sessions WHERE id=?'
        )
          .bind(agentSessionId)
          .first()
      ).toEqual({
        agent_credential_reference: f.credentialReference,
        agent_profile_id: f.profileId,
      });
      return Response.json({ ok: true });
    }
    const prompt = /\/agent-sessions\/([^/]+)\/prompt$/.exec(path);
    if (prompt)
      return Response.json(
        acceptedPromptResponse(prompt[1]!, String(body.deliveryId), runtimeIdentity, Date.now())
      );
    if (request.method === 'DELETE') {
      expect(path).toBe(`/workspaces/${f.workspaceId}/physical-deletion`);
      expect(body).toMatchObject({
        workspaceId: f.workspaceId,
        nodeId: f.nodeId,
        nodeRuntimeIncarnationId: `incarnation-${f.nodeId}`,
        userId: f.userId,
        workspaceGeneration: `generation-${f.workspaceId}`,
        deletionMode: 'automatic',
        preservationExpiresAt: expect.any(String),
      });
      return Response.json({ ...body, physicalDeleted: true, success: true });
    }
    if (path.endsWith('/stop') || path.endsWith('/start') || path.endsWith('/agent-sessions'))
      return Response.json({ ok: true });
    throw new Error(`Unexpected test VM endpoint: ${request.method} ${path}`);
  });
  return calls;
}

async function fireSchedule(f: Fixture) {
  await runInDurableObject(f.stub, async (instance, state) => {
    const pending: Promise<unknown>[] = [];
    const drain = vi.spyOn(state, 'waitUntil').mockImplementation((promise) => {
      pending.push(promise);
    });
    try {
      await instance.alarm();
      await Promise.all(pending);
    } finally {
      drain.mockRestore();
    }
  });
}

describe('provider limit -> canonical sleep -> full restored continuation', () => {
  it.each([
    { agentType: 'claude-code', restoreFailure: false, fixture: 0 },
    { agentType: 'openai-codex', restoreFailure: false, fixture: 2 },
    { agentType: 'claude-code', restoreFailure: true, fixture: 0 },
  ])(
    'restores $agentType safely through all steps (restore failure=$restoreFailure)',
    async ({ agentType, restoreFailure, fixture }) => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date(recorded.now));
      const f = await agentOnVm('task', agentType);
      const replacement = `replacement-${f.id}`;
      const calls = vmPeer(f, replacement, restoreFailure);
      const callback = callbackCases.find(
        (c) => c.name === recorded.cases[fixture]!.name
      )!.callback;
      expect(callback.providerLimitResetsAt).toBe(
        recorded.cases[fixture]!.callback.providerLimitResetsAt
      );
      const token = await signCallbackToken(f.workspaceId, testEnv);
      const response = await SELF.fetch(
        `https://api.test.example.com/api/projects/${f.projectId}/tasks/${f.taskId}/status/callback`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...callback,
            providerLimitAgentSessionId: `a-${f.id}`,
          }),
        }
      );
      expect(response.status, await response.text()).toBe(200);
      const waitRow = await env.DATABASE.prepare(
        'SELECT admission_state,provider_limit_wait_json FROM tasks WHERE id=?'
      )
        .bind(f.taskId)
        .first<{ admission_state: string; provider_limit_wait_json: string }>();
      expect(waitRow?.admission_state).toBe('provider_limit_waiting');
      const wait = parseProviderLimitWait(waitRow!.provider_limit_wait_json)!;
      expect(wait.scheduleId).toBeDefined();
      const sleep = await runSessionSleepSweep(testEnv);
      expect(sleep.slept).toBeGreaterThan(0);
      expect((await f.stub.getSession(f.chatSessionId))?.status).toBe('sleeping');
      expect((await taskRow(f.taskId))?.status).toBe('sleeping');
      expect(calls.some((c) => c.path.endsWith('/hibernate'))).toBe(true);
      expect(calls.some((c) => c.path === `/workspaces/${f.workspaceId}/stop`)).toBe(true);
      await deleteSleptWorkspace(f.nodeId, f.taskId);
      // Completed durable proof remains sufficient after its queue entry is
      // removed; the helper must not issue a second destructive request.
      const deletedRequests = calls.filter((c) => c.path.endsWith('/physical-deletion')).length;
      expect(deletedRequests).toBe(1);
      await deleteSleptWorkspace(f.nodeId, f.taskId);
      expect(calls.filter((c) => c.path.endsWith('/physical-deletion'))).toHaveLength(
        deletedRequests
      );
      const clock = {
        mockReturnValue: (now: number) => vi.setSystemTime(now),
        mockRestore: () => vi.useRealTimers(),
      };
      clock.mockReturnValue(wait.nextRetryAt + 1);
      await readyReplacementNode(f);
      try {
        await fireSchedule(f);
        expect(
          await sqlRows(
            f.stub,
            "SELECT id FROM session_inbox WHERE target_session_id=? AND source_kind='scheduled_action'",
            f.chatSessionId
          )
        ).toHaveLength(1);
        // Admission arms the next delivery alarm; drive that real tick too.
        clock.mockReturnValue(wait.nextRetryAt + 60_000);
        await fireSchedule(f);
        const [first] = await sqlRows<{ delivery_state: string; last_error: string }>(
          f.stub,
          "SELECT delivery_state,last_error FROM session_inbox WHERE target_session_id=? AND source_kind='scheduled_action'",
          f.chatSessionId
        );
        expect(first?.delivery_state).toBe('retry_wait');
        expect(first?.last_error).toContain(`Session is waking (${f.taskId})`);
        expect((await taskRunner(f.taskId).getStatus())?.taskId).toBe(f.taskId);
        if (restoreFailure) {
          for (let step = 0; step < 25 && !calls.some((c) => c.path.endsWith('/restore')); step++) {
            await runInDurableObject(taskRunner(f.taskId), (instance) => instance.alarm());
          }
          expect(calls.filter((c) => c.path.endsWith('/restore'))).toHaveLength(1);
          const state = await taskRunner(f.taskId).getStatus();
          expect(state?.stepResults.snapshotRestoreDeadlineAt).toEqual(expect.any(Number));
          clock.mockReturnValue(state!.stepResults.snapshotRestoreDeadlineAt! + 1);
          await runInDurableObject(taskRunner(f.taskId), (instance) => instance.alarm());
          expect((await taskRunner(f.taskId).getStatus())?.completed).toBe(true);
          expect(
            await env.DATABASE.prepare(
              'SELECT recovery_status FROM session_snapshots WHERE chat_session_id=?'
            )
              .bind(f.chatSessionId)
              .first()
          ).toEqual({ recovery_status: 'failed' });
          expect((await f.stub.getSession(f.chatSessionId))?.status).toBe('sleeping');
          expect(calls.filter((c) => c.path.endsWith('/prompt'))).toHaveLength(0);
          return;
        }
        await driveMove(f);
        await waitForWakeReadiness(f);
        expect((await runDueDelivery(f, wait.nextRetryAt + 60_000))?.kind).toBe('accepted');
        expect(
          await sqlRows(
            f.stub,
            "SELECT delivery_state FROM session_inbox WHERE target_session_id=? AND source_kind='scheduled_action'",
            f.chatSessionId
          )
        ).toEqual([{ delivery_state: 'acked' }]);
        const prompts = calls.filter((c) => c.path.endsWith('/prompt'));
        expect(prompts).toHaveLength(1);
        expect(String(prompts[0]!.body.prompt)).toContain(PROVIDER_LIMIT_CONTINUATION);
        expect(calls.filter((c) => c.path.endsWith('/restore'))).toHaveLength(1);
        expect((await taskRow(f.taskId))?.status).toBe('in_progress');
        const chat = await f.stub.getSession(f.chatSessionId);
        expect(chat?.status).toBe('active');
        expect(chat?.taskId).toBe(f.taskId);
        expect(chat?.workspaceId).not.toBe(f.workspaceId);
        expect(await runDueDelivery(f, wait.nextRetryAt + 120_000)).toBeNull();
        expect(calls.filter((c) => c.path.endsWith('/prompt'))).toHaveLength(1);
      } finally {
        clock.mockRestore();
      }
    },
    30_000
  );
});
