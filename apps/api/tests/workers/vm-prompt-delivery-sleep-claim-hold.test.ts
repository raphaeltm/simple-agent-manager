/**
 * Durable deliveries are held while a session's sleep is claimed.
 *
 * Production 2026-11-04 (idea 01M6K6QTEE7T9KNYB7317D7Y8E): an operator's required sleep cancelled
 * a hung turn. The VM restarted the agent idle, and within five seconds two durable prompts that
 * had been waiting behind the hung turn were delivered to it. The new turn aborted the sleep
 * ("Workspace activity changed while the final snapshot was captured") and the agent spent an
 * Opus turn on work nobody had asked for.
 *
 * The real path: the sleep claim is taken by `claimSessionSnapshotSleep` (the claim precedes the
 * required sleep's cancel in `sleepWorkspaceSession`), a message queued for the session is due,
 * and the production delivery runner attempts it against a VM double that would accept it.
 */
import { buildVmPromptDeliveryCapabilitiesPath } from '@simple-agent-manager/shared';
import { env, runInDurableObject } from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/d1';
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../src/db/schema';
import { resolveDurableExecutionConfig } from '../../src/durable-objects/project-data/durable-execution-config';
import {
  claimDuePromptDeliveries,
  type PromptDeliveryResult,
} from '../../src/durable-objects/project-data/prompt-delivery';
import { runPromptDeliveryClaim } from '../../src/durable-objects/project-data/prompt-delivery-runner';
import type { Env } from '../../src/env';
import { getNodeBackendBaseUrl } from '../../src/services/node-agent-readiness';
import { ensureSessionSnapshotForSleep } from '../../src/services/session-snapshot-prepare';
import { claimSessionSnapshotSleep } from '../../src/services/session-snapshot-sleep-claim';
import { failSessionSnapshotSleepBeforeTeardown } from '../../src/services/session-snapshot-sleep-failure';
import { DefaultVmPromptDeliveryAdapter } from '../../src/services/vm-prompt-delivery-adapter';
import { resolveVmPromptDeliveryTarget } from '../../src/services/vm-prompt-delivery-target';
import {
  acceptedPromptResponse,
  versionedPromptCapabilities,
} from '../helpers/vm-prompt-delivery-fixtures';
import {
  inboxRows,
  okBody,
  sqlRows,
  testEnv,
  twoAgentProject,
} from './helpers/agent-message-channels';

const config = resolveDurableExecutionConfig({});
const RUNTIME_IDENTITY = 'sleep-claim-runtime';
const CLAIM_ID = 'sleep-claim-1';

afterEach(() => {
  vi.restoreAllMocks();
});

type Fixture = Awaited<ReturnType<typeof twoAgentProject>> & { nodeId: string };

/** Agent B's conversation is running; agent A queues a durable message for it. */
async function runningConversationWithQueuedMessage(): Promise<Fixture> {
  const f = await twoAgentProject();
  const node = await env.DATABASE.prepare('SELECT node_id FROM workspaces WHERE id = ?')
    .bind(f.b.workspaceId)
    .first<{ node_id: string }>();
  okBody(
    await f.a.tool('send_durable_message', {
      targetTaskId: f.b.taskId,
      message: 'Stale handoff: please check production deploys.',
    })
  );
  const inbox = await inboxRows(f.stub);
  expect(inbox).toHaveLength(1);
  expect(inbox[0]).toMatchObject({ target_session_id: f.b.sessionId });
  return { ...f, nodeId: node!.node_id };
}

/** The sleep writers `sleepWorkspaceSession` runs before it cancels the turn. */
async function claimSleep(f: Fixture) {
  const db = drizzle(env.DATABASE, { schema });
  await ensureSessionSnapshotForSleep(db, testEnv, {
    workspaceId: f.b.workspaceId,
    nodeId: f.nodeId,
    projectId: f.projectId,
    userId: f.memberId,
    chatSessionId: f.b.sessionId,
    agentSessionId: f.b.agentSessionId,
    runtime: 'vm',
  });
  const claim = await claimSessionSnapshotSleep(db, testEnv, {
    chatSessionId: f.b.sessionId,
    claimId: CLAIM_ID,
    force: true,
    markRequired: true,
  });
  expect(claim).toMatchObject({ status: 'claimed', phase: 'preparing' });
}

/** VM agent double for B's workspace: accepts every prompt and records it. */
function installVm(f: Fixture) {
  const prompts: string[] = [];
  const base = getNodeBackendBaseUrl(f.nodeId, testEnv);
  const passthrough = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    if (!request.url.startsWith(base)) return passthrough(input, init);
    const url = new URL(request.url);
    if (url.pathname === buildVmPromptDeliveryCapabilitiesPath(f.b.workspaceId)) {
      return Response.json(versionedPromptCapabilities(RUNTIME_IDENTITY));
    }
    const prompt = /\/agent-sessions\/([^/]+)\/prompt$/.exec(url.pathname);
    if (prompt) {
      const text = typeof init?.body === 'string' ? init.body : await request.text();
      const body = JSON.parse(text) as { deliveryId?: string };
      prompts.push(String(body.deliveryId));
      return Response.json(
        acceptedPromptResponse(prompt[1]!, String(body.deliveryId), RUNTIME_IDENTITY, Date.now())
      );
    }
    return Response.json({ ok: true });
  });
  return { prompts };
}

/** One pass of the production delivery claim runner for whatever is due at `now`. */
async function runDueDelivery(f: Fixture, now: number): Promise<PromptDeliveryResult | null> {
  return runInDurableObject(f.stub, async (instance, state) => {
    const [claim] = claimDuePromptDeliveries(state.storage.sql, config, now);
    if (!claim) return null;
    const objectEnv = (instance as unknown as { env: Env }).env;
    return runPromptDeliveryClaim(
      state.storage.sql,
      objectEnv,
      config,
      claim,
      new DefaultVmPromptDeliveryAdapter(objectEnv),
      {
        projectId: f.projectId,
        recalculateAlarm: async () => undefined,
        broadcastEvent: () => undefined,
        armIdleCleanup: () => undefined,
        nudgeDeliveries: () => 0,
        scheduleSummarySync: () => undefined,
      }
    );
  });
}

async function deliveryState(f: Fixture) {
  const [row] = await sqlRows<{ delivery_state: string; last_error: string | null }>(
    f.stub,
    'SELECT delivery_state, last_error FROM session_inbox WHERE target_session_id = ?',
    f.b.sessionId
  );
  return row;
}

describe('durable delivery while a sleep is claimed', () => {
  it('holds a queued message while the sleep owns the session, then delivers it once released', async () => {
    const f = await runningConversationWithQueuedMessage();
    const vm = installVm(f);
    await claimSleep(f);

    const held = await runDueDelivery(f, Date.now());

    expect(held).toMatchObject({ kind: 'retry', reason: 'not_ready' });
    expect(vm.prompts).toEqual([]);
    expect(await deliveryState(f)).toMatchObject({
      delivery_state: 'retry_wait',
      last_error: 'Session is going to sleep (preparing)',
    });

    // The sleep fails before teardown (the real failure writer releases the claim). The
    // session stays awake, so the held message is delivered on its next attempt.
    const db = drizzle(env.DATABASE, { schema });
    expect(
      await failSessionSnapshotSleepBeforeTeardown(
        db,
        testEnv,
        f.b.sessionId,
        CLAIM_ID,
        'Workspace activity changed while the final snapshot was captured'
      )
    ).toBe(true);
    const [retry] = await sqlRows<{ next_attempt_at: number }>(
      f.stub,
      'SELECT next_attempt_at FROM session_inbox WHERE target_session_id = ?',
      f.b.sessionId
    );
    const delivered = await runDueDelivery(f, retry!.next_attempt_at);

    expect(delivered).toMatchObject({ kind: 'accepted' });
    expect(vm.prompts).toHaveLength(1);
  });

  it('delivers to a running session with no sleep claim (control)', async () => {
    const f = await runningConversationWithQueuedMessage();
    const vm = installVm(f);

    expect(await runDueDelivery(f, Date.now())).toMatchObject({ kind: 'accepted' });
    expect(vm.prompts).toHaveLength(1);
  });

  it('does not let an abandoned preparing claim hold deliveries past its lease', async () => {
    const f = await runningConversationWithQueuedMessage();
    const vm = installVm(f);
    await claimSleep(f);
    await env.DATABASE.prepare(
      "UPDATE session_snapshots SET sleep_claimed_at = '2026-01-01T00:00:00.000Z' WHERE chat_session_id = ?"
    )
      .bind(f.b.sessionId)
      .run();

    expect(await runDueDelivery(f, Date.now())).toMatchObject({ kind: 'accepted' });
    expect(vm.prompts).toHaveLength(1);
  });

  it('holds a session whose sleep is past its point of no return (stopping)', async () => {
    const f = await runningConversationWithQueuedMessage();
    await claimSleep(f);
    await env.DATABASE.prepare(
      "UPDATE session_snapshots SET sleep_status = 'stopping' WHERE chat_session_id = ?"
    )
      .bind(f.b.sessionId)
      .run();

    const resolution = await resolveVmPromptDeliveryTarget(
      testEnv,
      f.projectId,
      f.b.sessionId,
      undefined,
      async () => null
    );

    expect(resolution).toEqual({ kind: 'retry', reason: 'Session is going to sleep (stopping)' });
  });
  // Rule 61: an Instant (cf-container) session's sleep claim holds deliveries the same way.
  it('holds an Instant session whose sleep is claimed', async () => {
    const f = await runningConversationWithQueuedMessage();
    await claimSleep(f);
    await env.DATABASE.batch([
      env.DATABASE.prepare("UPDATE nodes SET runtime = 'cf-container' WHERE id = ?").bind(f.nodeId),
      env.DATABASE.prepare(
        "UPDATE session_snapshots SET runtime = 'cf-container' WHERE chat_session_id = ?"
      ).bind(f.b.sessionId),
    ]);

    const resolve = () =>
      resolveVmPromptDeliveryTarget(
        testEnv,
        f.projectId,
        f.b.sessionId,
        undefined,
        async () => null
      );

    expect(await resolve()).toEqual({
      kind: 'retry',
      reason: 'Session is going to sleep (preparing)',
    });
    // Control: once the claim is released the same Instant runtime is a ready target.
    const db = drizzle(env.DATABASE, { schema });
    await failSessionSnapshotSleepBeforeTeardown(db, testEnv, f.b.sessionId, CLAIM_ID, 'test');
    expect(await resolve()).toMatchObject({
      kind: 'ready',
      target: { workspaceId: f.b.workspaceId, runtime: 'cf-container' },
    });
  });
});
