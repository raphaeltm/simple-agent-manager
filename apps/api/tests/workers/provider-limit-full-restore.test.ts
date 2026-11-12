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
import { preserveProviderLimitWait } from '../../src/services/provider-limit-reconciliation';
import { ensureSessionRecovery } from '../../src/services/session-recovery';
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
import { seedSignedInUser } from './helpers/seed-d1';

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

type RestoreInjection = { workspaceId: string; agentSessionId: string; token: string };
type RestoreInjectionHooks = {
  before?: (injection: RestoreInjection) => Promise<void>;
  observe?: (response: Response, injection: RestoreInjection) => Promise<void>;
  expectedStatus?: number;
};

function vmPeer(
  f: Fixture,
  replacementNode: string,
  restoreFailure: boolean,
  injectionHooks: RestoreInjectionHooks = {}
) {
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
      // A real VM resolves/injects the selected account when it loads the saved
      // harness too. Model that callback, not only the fresh /start branch.
      const injection = {
        workspaceId,
        agentSessionId: path.split('/')[4]!,
        token: tokens.get(workspaceId)!,
      };
      await injectionHooks.before?.(injection);
      const injected = await SELF.fetch(
        `https://api.test.example.com/api/workspaces/${workspaceId}/agent-key`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${tokens.get(workspaceId)}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ agentType: f.agentType, agentSessionId: path.split('/')[4] }),
        }
      );
      expect(injected.status, await injected.clone().text()).toBe(
        injectionHooks.expectedStatus ?? 200
      );
      await injectionHooks.observe?.(injected, injection);
      return Response.json({
        status: restoreFailure || injected.status !== 200 ? 'failed' : 'restored',
      });
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
      const token = await signCallbackToken(f.workspaceId, testEnv, { callbackGeneration: null });
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

describe('owner force-resume before the recorded reset through public HTTP', () => {
  it.each([false, true])(
    'retains the original delivery and snapshot (claimed=%s)',
    async (claimed) => {
      const currentTime = Date.now();
      const recordedResetOffset =
        Number(callbackCases[0]!.callback.providerLimitResetsAt) - Date.parse(recorded.now);
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(currentTime);
      const f = await agentOnVm('task');
      const calls = vmPeer(f, `replacement-${f.id}`, false);
      const token = await signCallbackToken(f.workspaceId, testEnv, { callbackGeneration: null });
      const callback = await SELF.fetch(
        `https://api.test.example.com/api/projects/${f.projectId}/tasks/${f.taskId}/status/callback`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...callbackCases[0]!.callback,
            providerLimitResetsAt: currentTime + recordedResetOffset,
            providerLimitAgentSessionId: `a-${f.id}`,
          }),
        }
      );
      expect(callback.status, await callback.text()).toBe(200);
      await runSessionSleepSweep(testEnv);
      await deleteSleptWorkspace(f.nodeId, f.taskId);
      await readyReplacementNode(f);
      const deliveryId = `original-human-message-${f.id}`;
      const accepted = await f.stub.acceptPromptDelivery({
        deliveryId,
        targetSessionId: f.chatSessionId,
        sourceTaskId: f.taskId,
        senderType: 'human',
        senderId: f.userId,
        sourceKind: 'user_followup',
        messageClass: 'deliver',
        displayContent: 'Please continue my existing work now.',
        deliveryContent: 'Please continue my existing work now.',
        ttlMs: 60 * 60_000,
      });
      const waitBefore = parseProviderLimitWait(
        (await env.DATABASE.prepare('SELECT * FROM tasks WHERE id=?')
          .bind(f.taskId)
          .first<Record<string, unknown>>())!.provider_limit_wait_json as string
      )!;
      expect(waitBefore.nextRetryAt).toBeGreaterThan(Date.now());
      if (claimed) {
        expect(await ensureSessionRecovery(testEnv, f.projectId, f.chatSessionId)).toMatchObject({
          status: 'waking',
          taskId: f.taskId,
        });
        // The existing runner really holds on the old future timer.
        await runInDurableObject(taskRunner(f.taskId), (instance) => instance.alarm());
        expect(
          (
            await env.DATABASE.prepare('SELECT * FROM tasks WHERE id=?')
              .bind(f.taskId)
              .first<Record<string, unknown>>()
          )?.admission_state
        ).toBe('provider_limit_waiting');
      }
      const snapshotBefore = await env.DATABASE.prepare(
        'SELECT * FROM session_snapshots WHERE chat_session_id=?'
      )
        .bind(f.chatSessionId)
        .first();
      const cookie = await seedSignedInUser(f.userId);
      const act = () =>
        SELF.fetch(
          `https://api.test.example.com/api/projects/${f.projectId}/tasks/${f.taskId}/provider-limit/start-anyway`,
          {
            method: 'POST',
            headers: { Cookie: cookie, Origin: 'https://app.test.example.com' },
          }
        );
      const response = await act();
      expect(response.status, await response.clone().text()).toBe(202);
      expect(await response.json()).toMatchObject({ status: 'waking', taskId: f.taskId });
      expect((await act()).status).toBe(409);
      const snapshotAfter = await env.DATABASE.prepare(
        'SELECT * FROM session_snapshots WHERE chat_session_id=?'
      )
        .bind(f.chatSessionId)
        .first();
      expect(snapshotAfter).toMatchObject({
        id: snapshotBefore!.id,
        manifest_r2_key: snapshotBefore!.manifest_r2_key,
      });
      if (claimed)
        expect(snapshotAfter!.recovery_attempt_id).toBe(snapshotBefore!.recovery_attempt_id);
      await driveMove(f);
      await waitForWakeReadiness(f);
      for (let pass = 0; pass < 4; pass++) await runDueDelivery(f, Date.now() + pass * 60_000);
      const prompts = calls.filter(
        (c) => c.path.endsWith('/prompt') && c.body.deliveryId === deliveryId
      );
      expect(prompts).toHaveLength(1);
      expect(prompts[0]!.body.prompt).toBe('Please continue my existing work now.');
      expect(
        await sqlRows(
          f.stub,
          'SELECT id,prompt_message_id,delivery_state FROM session_inbox WHERE id=?',
          deliveryId
        )
      ).toEqual([
        {
          id: deliveryId,
          prompt_message_id: accepted.message.promptMessageId,
          delivery_state: 'acked',
        },
      ]);
      // Late old scheduled continuations cannot cause an extra provider prompt.
      vi.setSystemTime(waitBefore.nextRetryAt + 1);
      await fireSchedule(f);
      for (let pass = 0; pass < 3; pass++) await runDueDelivery(f, Date.now() + pass * 60_000);
      expect(
        calls.filter(
          (c) =>
            c.path.endsWith('/prompt') &&
            String(c.body.prompt).includes(PROVIDER_LIMIT_CONTINUATION)
        )
      ).toHaveLength(0);
      const running = await env.DATABASE.prepare(
        `SELECT a.id,a.agent_credential_generation,w.id AS workspace_id,w.callback_generation
         FROM tasks t JOIN workspaces w ON w.id=t.workspace_id
         JOIN agent_sessions a ON a.workspace_id=w.id AND a.status='running' WHERE t.id=?`
      )
        .bind(f.taskId)
        .first<{
          id: string;
          agent_credential_generation: number;
          workspace_id: string;
          callback_generation: string | null;
        }>();
      const nextToken = await signCallbackToken(running!.workspace_id, testEnv, {
        callbackGeneration: running!.callback_generation,
      });
      const rejectedAgain = await SELF.fetch(
        `https://api.test.example.com/api/projects/${f.projectId}/tasks/${f.taskId}/status/callback`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${nextToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...callbackCases[0]!.callback,
            providerLimitAgentSessionId: running!.id,
            providerLimitCredentialGeneration: running!.agent_credential_generation,
            providerLimitPromptAttemptId: 99,
          }),
        }
      );
      expect(rejectedAgain.status, await rejectedAgain.text()).toBe(200);
      const parkedAgain = await env.DATABASE.prepare(
        'SELECT admission_state,provider_limit_wait_json FROM tasks WHERE id=?'
      )
        .bind(f.taskId)
        .first<{ admission_state: string; provider_limit_wait_json: string }>();
      expect(parkedAgain!.admission_state).toBe('provider_limit_waiting');
      const freshWait = parseProviderLimitWait(parkedAgain!.provider_limit_wait_json)!;
      expect(freshWait.ownerOverride).toBeUndefined();
      expect(freshWait.scheduleKey).not.toBe(waitBefore.scheduleKey);
    },
    30_000
  );
});

/** Keep recovery and injection real; fault only the TaskRunner RPC acknowledgement. */
describe('owner consent survives credential release and placed recovery', () => {
  async function approvedFixture(hooks: RestoreInjectionHooks = {}) {
    // Capture wall time before installing Date doubles: SQLite's atomic consent
    // fence uses julianday('now') and does not share Vitest's fake clock.
    const currentTime = Date.now();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(currentTime);
    const f = await agentOnVm('task');
    const calls = vmPeer(f, `replacement-${f.id}`, false, hooks);
    const token = await signCallbackToken(f.workspaceId, testEnv, { callbackGeneration: null });
    const rejected = await SELF.fetch(
      `https://api.test.example.com/api/projects/${f.projectId}/tasks/${f.taskId}/status/callback`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...callbackCases[0]!.callback,
          providerLimitAgentSessionId: `a-${f.id}`,
        }),
      }
    );
    expect(rejected.status, await rejected.text()).toBe(200);
    await runSessionSleepSweep(testEnv);
    await deleteSleptWorkspace(f.nodeId, f.taskId);
    await readyReplacementNode(f);
    const deliveryId = `pending-original-${f.id}`;
    const accepted = await f.stub.acceptPromptDelivery({
      deliveryId,
      targetSessionId: f.chatSessionId,
      sourceTaskId: f.taskId,
      senderType: 'human',
      senderId: f.userId,
      sourceKind: 'user_followup',
      messageClass: 'deliver',
      displayContent: 'Continue this original message exactly once.',
      deliveryContent: 'Continue this original message exactly once.',
      ttlMs: 60 * 60_000,
    });
    expect(await ensureSessionRecovery(testEnv, f.projectId, f.chatSessionId)).toMatchObject({
      status: 'waking',
      taskId: f.taskId,
    });
    await runInDurableObject(taskRunner(f.taskId), (instance) => instance.alarm());
    const cookie = await seedSignedInUser(f.userId);
    const act = () =>
      SELF.fetch(
        `https://api.test.example.com/api/projects/${f.projectId}/tasks/${f.taskId}/provider-limit/start-anyway`,
        { method: 'POST', headers: { Cookie: cookie, Origin: 'https://app.test.example.com' } }
      );
    return { f, calls, act, deliveryId, promptMessageId: accepted.message.promptMessageId };
  }

  async function intent(f: Fixture) {
    const row = await env.DATABASE.prepare(
      'SELECT status,admission_state,provider_limit_wait_json FROM tasks WHERE id=?'
    )
      .bind(f.taskId)
      .first<{
        status: string;
        admission_state: string | null;
        provider_limit_wait_json: string;
      }>();
    return { ...row!, wait: parseProviderLimitWait(row!.provider_limit_wait_json)! };
  }

  it.each(['acknowledged', 'timeout then late completion'] as const)(
    'preserves marker consent through placed recovery with %s acknowledgement',
    async (outcome) => {
      let observedFirstInjection = false;
      const prepared = await approvedFixture({
        observe: async (_response, injection) => {
          const current = await intent(prepared.f);
          expect(current.admission_state).toBe('placed');
          expect(current.wait.ownerOverride?.recoveryPending).toBe(true);
          expect(current.wait.ownerOverride?.firstInjection).toMatchObject({
            workspaceId: injection.workspaceId,
            agentSessionId: injection.agentSessionId,
            authorizedAt: expect.any(Number),
            credentialGeneration: expect.any(Number),
          });
          observedFirstInjection = true;
        },
      });
      const { f, calls } = prepared;
      const snapshotBefore = await env.DATABASE.prepare(
        'SELECT id,recovery_attempt_id,manifest_r2_key FROM session_snapshots WHERE chat_session_id=?'
      )
        .bind(f.chatSessionId)
        .first();
      let repairNudgeEntered = false;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let repairNudgeCompleted = false;
      let restoreSpy = () => {};
      await runInDurableObject(taskRunner(f.taskId), async (instance) => {
        // Workers RPC exposes prototype methods, not instance-owned functions.
        const prototype: Pick<typeof instance, 'nudge'> = Object.getPrototypeOf(instance);
        const nudge = prototype.nudge;
        const spy = vi.spyOn(prototype, 'nudge').mockImplementation(async function (
          this: typeof instance,
          ...args
        ) {
          const accepted = await nudge.apply(this, args);
          if (this !== instance) return accepted;
          const [reason] = args;
          if (reason === 'Owner resumed despite provider limit')
            throw new Error('test peer lost the public action acknowledgement');
          if (reason === 'Retry owner-approved provider limit recovery') {
            repairNudgeEntered = true;
            await gate;
            repairNudgeCompleted = true;
          }
          return accepted;
        });
        restoreSpy = () => spy.mockRestore();
      });
      try {
        const response = await prepared.act();
        expect(response.status, await response.clone().text()).toBe(409);
        const pending = await intent(f);
        expect(pending.admission_state).toBe('provider_limit_recovery_pending');
        expect(pending.wait.ownerOverride?.firstInjection).toBeUndefined();
        const repairEnv = {
          ...testEnv,
          PROMPT_DELIVERY_BACKGROUND_TIMEOUT_MS: outcome === 'acknowledged' ? '30000' : '1',
        };
        const repair = preserveProviderLimitWait(repairEnv, f.taskId, Date.now());
        // Poll from the test's I/O context instead of resolving a test promise
        // inside the TaskRunner DO. A tiny caller budget may settle before RPC
        // transit reaches nudge; the late operation must still reach this gate.
        let repairFailure: unknown;
        let repairFailed = false;
        void repair.catch((error) => {
          repairFailure = error;
          repairFailed = true;
        });
        await vi.waitFor(
          () => {
            if (repairFailed) throw repairFailure;
            expect(repairNudgeEntered).toBe(true);
          },
          { timeout: 5_000, interval: 10 }
        );
        if (outcome !== 'acknowledged') await repair;
        // The real restore invokes the public agent-key callback and changes only
        // firstInjection while repair still owns the older consent JSON receipt.
        await driveMove(f);
        expect(observedFirstInjection).toBe(true);
        expect((await taskRow(f.taskId))?.status).toBe('in_progress');
        const afterInjection = await intent(f);
        expect(afterInjection.wait.ownerOverride?.firstInjection).toBeDefined();
        expect(afterInjection.admission_state).toBe('placed');
        expect(afterInjection.wait.ownerOverride?.recoveryPending).toBe(true);
        release();
        await repair;
        await vi.waitFor(() => expect(repairNudgeCompleted).toBe(true));
        // Placement has legitimately replaced the pending admission mirror.
        // An ACK for the older receipt must never overwrite that real progress.
        expect(await intent(f)).toEqual(afterInjection);
        if (outcome !== 'acknowledged') {
          expect(await preserveProviderLimitWait(testEnv, f.taskId, Date.now())).toBe(false);
          expect(await intent(f)).toEqual(afterInjection);
        }
        expect((await intent(f)).admission_state).toBe('placed');
        expect((await intent(f)).wait.ownerOverride?.firstInjection).toEqual(
          afterInjection.wait.ownerOverride?.firstInjection
        );
        expect(
          await env.DATABASE.prepare(
            'SELECT id,recovery_attempt_id,manifest_r2_key FROM session_snapshots WHERE chat_session_id=?'
          )
            .bind(f.chatSessionId)
            .first()
        ).toEqual(snapshotBefore);
        await waitForWakeReadiness(f);
        for (let pass = 0; pass < 3; pass++) await runDueDelivery(f, Date.now() + pass * 60_000);
        expect(calls.filter((call) => call.path.endsWith('/restore'))).toHaveLength(1);
        expect(
          calls.filter(
            (call) => call.path.endsWith('/prompt') && call.body.deliveryId === prepared.deliveryId
          )
        ).toHaveLength(1);
        expect(
          await sqlRows(
            f.stub,
            'SELECT id,prompt_message_id,delivery_state FROM session_inbox WHERE id=?',
            prepared.deliveryId
          )
        ).toEqual([
          {
            id: prepared.deliveryId,
            prompt_message_id: prepared.promptMessageId,
            delivery_state: 'acked',
          },
        ]);
      } finally {
        release();
        restoreSpy();
      }
    },
    30_000
  );

  it.each(['expired', 'membership revoked'] as const)(
    'withholds the first restore credential when approval is %s',
    async (change) => {
      let denied = false;
      const prepared = await approvedFixture({
        expectedStatus: 409,
        before: async () => {
          const current = await intent(prepared.f);
          expect(current.wait.ownerOverride?.firstInjection).toBeUndefined();
          if (change === 'expired') vi.setSystemTime(current.wait.ownerOverride!.expiresAt! + 1);
          else
            await env.DATABASE.prepare(
              "UPDATE project_members SET role='viewer' WHERE project_id=? AND user_id=?"
            )
              .bind(prepared.f.projectId, prepared.f.userId)
              .run();
        },
        observe: async (response) => {
          expect(await response.clone().text()).not.toContain('test-only-agent-token');
          const current = await intent(prepared.f);
          expect(current.admission_state).toBe('provider_limit_blocked');
          expect(current.wait.ownerOverride).toBeUndefined();
          denied = true;
        },
      });
      const response = await prepared.act();
      expect(response.status, await response.clone().text()).toBe(202);
      for (let step = 0; step < 25 && !denied; step++)
        await runInDurableObject(taskRunner(prepared.f.taskId), (instance) => instance.alarm());
      expect(denied).toBe(true);
      expect(prepared.calls.filter((call) => call.path.endsWith('/prompt'))).toHaveLength(0);
      const [delivery] = await sqlRows<{ delivery_state: string }>(
        prepared.f.stub,
        'SELECT delivery_state FROM session_inbox WHERE id=?',
        prepared.deliveryId
      );
      expect(delivery?.delivery_state).not.toBe('acked');
    },
    30_000
  );
});
