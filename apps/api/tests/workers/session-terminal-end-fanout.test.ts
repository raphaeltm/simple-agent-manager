/**
 * `stopSession` / `failSession` must terminalize the activity mirror.
 *
 * These transitions used to write only `chat_sessions.status`, so a session
 * ended mid-turn left `session_state.activity` reporting `prompting` until the
 * 5-minute probe sweep noticed. All three consumers of "is this session
 * mid-prompt" broke together — the stop button, durable-message delivery and
 * idle scheduling (.claude/rules/57).
 *
 * Driven through the REAL Durable Object RPCs inside workerd, so the test
 * exercises the same entry point production takes rather than the SQL helpers
 * underneath it (.claude/rules/62).
 */
import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import type { ProjectData } from '../../src/durable-objects/project-data';

function getStub(projectId: string): DurableObjectStub<ProjectData> {
  const id = env.PROJECT_DATA.idFromName(projectId);
  return env.PROJECT_DATA.get(id) as DurableObjectStub<ProjectData>;
}

/**
 * Park a durable message in `retry_wait` behind an in-flight turn — the exact
 * state symptom B leaves a follow-up prompt in ("Target VM is currently
 * processing a prompt"). Returns a reader for its `next_attempt_at` so a test
 * can prove the message was actually RELEASED, not merely that some code ran.
 */
async function queueBlockedDelivery(
  stub: DurableObjectStub<ProjectData>,
  chatSessionId: string,
  parkedUntil: number
): Promise<() => Promise<number | null>> {
  await runInDurableObject(stub, async (instance: ProjectData) => {
    const sql = (instance as unknown as { sql: SqlStorage }).sql;
    sql.exec(
      `INSERT INTO session_inbox
         (id, target_session_id, message_type, content, priority, created_at,
          delivery_state, next_attempt_at, last_error, source_kind)
       VALUES ('msg-blocked', ?, 'prompt', 'Carry on...', 'normal', ?, 'retry_wait', ?, ?, 'agent_mailbox')`,
      chatSessionId,
      Date.now() - 60 * 60 * 1000,
      parkedUntil,
      'Target VM is currently processing a prompt'
    );
  });

  return async () =>
    runInDurableObject(stub, (instance: ProjectData) => {
      const sql = (instance as unknown as { sql: SqlStorage }).sql;
      const row = sql
        .exec('SELECT next_attempt_at FROM session_inbox WHERE id = ?', 'msg-blocked')
        .toArray()[0];
      return (row?.next_attempt_at as number | null) ?? null;
    });
}

/** A chat session with a linked ACP session, both reporting a working turn. */
async function seedWorkingSession(projectId: string): Promise<{
  stub: DurableObjectStub<ProjectData>;
  chatSessionId: string;
  acpSessionId: string;
}> {
  const stub = getStub(projectId);
  const chatSessionId = await stub.createSession('ws-1', 'Working session');
  const acp = await stub.createAcpSession({
    chatSessionId,
    initialPrompt: 'do the thing',
    agentType: 'claude-code',
  });

  // The VM reports the turn against the ACP session id; the browser-facing
  // state is keyed by the chat session id. Production has both.
  await stub.reportActivity(acp.id, 'prompting');
  await stub.reportActivity(chatSessionId, 'prompting');

  return { stub, chatSessionId, acpSessionId: acp.id };
}

describe('session terminal end — activity mirror fan-out', () => {
  it('stopSession clears a working mirror on BOTH the chat and ACP keyings', async () => {
    const { stub, chatSessionId, acpSessionId } = await seedWorkingSession('term-stop-1');

    // Precondition — without this the assertions below could pass vacuously.
    expect((await stub.getSessionState(acpSessionId))?.activity).toBe('prompting');
    expect((await stub.getSessionState(chatSessionId))?.activity).toBe('prompting');

    await expect(stub.stopSession(chatSessionId)).resolves.toBe(true);

    const acpState = await stub.getSessionState(acpSessionId);
    const chatState = await stub.getSessionState(chatSessionId);
    expect(acpState?.activity).toBe('stopped');
    expect(chatState?.activity).toBe('stopped');
    expect(acpState?.promptStartedAt).toBeNull();
    expect(chatState?.lastStopReason).toBe('Session stopped');
  });

  /**
   * The idle schedule's expiry is what actually calls `stopWorkspaceInD1`, and
   * some callers deliberately end the session while keeping the workspace
   * running (`scheduled/stuck-tasks.ts` transitions with `stopWorkspace: false`
   * before failing the session). So a terminal transition must do NEITHER of the
   * two obvious things: re-arming pushes teardown out on a session that will
   * never report again, and cancelling deletes that workspace's only teardown
   * path. It leaves the original deadline exactly where it was.
   */
  it('stopSession neither re-arms nor deletes the idle cleanup schedule', async () => {
    const { stub, chatSessionId } = await seedWorkingSession('term-stop-2');
    await stub.scheduleIdleCleanup(chatSessionId, 'ws-1', null);
    const scheduledAt = await stub.getCleanupAt(chatSessionId);
    expect(scheduledAt).toBeGreaterThan(0);

    await stub.stopSession(chatSessionId);

    // Unchanged: not pushed forward (which `publishTurnEnd`'s `armIdleCleanup`
    // hook would do via `resetIdleCleanup`), and not deleted.
    expect(await stub.getCleanupAt(chatSessionId)).toBe(scheduledAt);
  });

  it('a TURN ending still re-arms the idle timer (discriminating control)', async () => {
    const { stub, chatSessionId, acpSessionId } = await seedWorkingSession('term-turn-rearm');
    await stub.scheduleIdleCleanup(chatSessionId, 'ws-1', null);
    const scheduledAt = (await stub.getCleanupAt(chatSessionId))!;

    // Without this control, "the schedule was untouched" would also pass if the
    // idle-timer handling were removed altogether.
    await stub.recordSessionTurnEnd(acpSessionId, {
      reason: 'cancelled',
      observedAt: Date.now(),
    });

    expect(await stub.getCleanupAt(chatSessionId)).toBeGreaterThan(scheduledAt);
  });

  it('failSession terminalizes the mirror and retains the failure context', async () => {
    const { stub, chatSessionId, acpSessionId } = await seedWorkingSession('term-fail-1');

    await expect(stub.failSession(chatSessionId, 'Agent crashed')).resolves.toBe(true);

    const acpState = await stub.getSessionState(acpSessionId);
    expect(acpState?.activity).toBe('error');
    expect(acpState?.statusError).toBe('Agent crashed');
    expect(acpState?.promptStartedAt).toBeNull();
  });

  it('leaves an unrelated session in the same project untouched (scoping control)', async () => {
    const stub = getStub('term-scope-1');
    const victim = await stub.createSession('ws-1', 'Should be stopped');
    const bystanderAcp = await (async () => {
      const bystander = await stub.createSession('ws-2', 'Should keep working');
      const acp = await stub.createAcpSession({
        chatSessionId: bystander,
        initialPrompt: 'keep going',
        agentType: 'claude-code',
      });
      await stub.reportActivity(acp.id, 'prompting');
      return acp.id;
    })();
    const victimAcp = await stub.createAcpSession({
      chatSessionId: victim,
      initialPrompt: 'stop me',
      agentType: 'claude-code',
    });
    await stub.reportActivity(victimAcp.id, 'prompting');

    await stub.stopSession(victim);

    expect((await stub.getSessionState(victimAcp.id))?.activity).toBe('stopped');
    // Liveness assertion beside the absence assertion (.claude/rules/62 §5):
    // the bystander must still be positively working, not merely "not stopped".
    expect((await stub.getSessionState(bystanderAcp))?.activity).toBe('prompting');
  });

  it('is a no-op for an already-stopped session and does not re-broadcast', async () => {
    const { stub, chatSessionId } = await seedWorkingSession('term-stop-3');
    await expect(stub.stopSession(chatSessionId)).resolves.toBe(true);

    // `terminateSession` only matches active/sleeping rows, so a second stop
    // reports false and must not run the fan-out again.
    await expect(stub.stopSession(chatSessionId)).resolves.toBe(false);
    expect((await stub.getSessionState(chatSessionId))?.activity).toBe('stopped');
  });

  it('stopSession RELEASES a delivery parked behind the ended turn', async () => {
    const { stub, chatSessionId } = await seedWorkingSession('term-nudge-1');
    const parkedUntil = Date.now() + 30 * 60 * 1000;
    const readNextAttempt = await queueBlockedDelivery(stub, chatSessionId, parkedUntil);
    // Precondition — the message really is parked, so the assertion below cannot
    // pass vacuously.
    expect(await readNextAttempt()).toBe(parkedUntil);

    await stub.stopSession(chatSessionId);

    // The third consumer of "is this session mid-prompt". Without this the
    // message would sit in retry_wait behind a turn that will never finish —
    // which is symptom B.
    const released = await readNextAttempt();
    expect(released).not.toBeNull();
    expect(released!).toBeLessThan(parkedUntil);
  });

  it('failSession likewise releases a parked delivery', async () => {
    const { stub, chatSessionId } = await seedWorkingSession('term-nudge-2');
    const parkedUntil = Date.now() + 30 * 60 * 1000;
    const readNextAttempt = await queueBlockedDelivery(stub, chatSessionId, parkedUntil);

    await stub.failSession(chatSessionId, 'Agent crashed');

    const released = await readNextAttempt();
    expect(released!).toBeLessThan(parkedUntil);
  });

  /**
   * The capability test for the ACTUAL user-reported outcome (symptom B):
   * interrupt mid-turn, then the follow-up you already sent gets delivered.
   *
   * Driven through `recordSessionTurnEnd` — the DO RPC `chat-cancel.ts` calls —
   * with a real queued delivery, so it exercises the whole composition
   * (CAS -> publishTurnEnd -> nudge) rather than each layer separately
   * (.claude/rules/10, .claude/rules/35).
   */
  it('interrupt -> turn ends -> the queued follow-up is released', async () => {
    const { stub, chatSessionId, acpSessionId } = await seedWorkingSession('term-cancel-e2e');
    const parkedUntil = Date.now() + 30 * 60 * 1000;
    const readNextAttempt = await queueBlockedDelivery(stub, chatSessionId, parkedUntil);
    expect(await readNextAttempt()).toBe(parkedUntil);

    // The user presses Interrupt. `chat-cancel.ts` captures `observedAt` BEFORE
    // its VM round-trip, then records the turn end with it.
    const observedAt = Date.now();
    await expect(
      stub.recordSessionTurnEnd(acpSessionId, { reason: 'cancelled', observedAt })
    ).resolves.toBe(true);

    expect((await stub.getSessionState(acpSessionId))?.activity).toBe('idle');
    const released = await readNextAttempt();
    expect(released!).toBeLessThan(parkedUntil);
  });

  /**
   * `stopSession`/`failSession` never scheduled a Durable Object alarm before
   * this fan-out existed. Scheduling one unconditionally makes every terminal
   * transition wake the object to re-read all nine alarm sources and run storage
   * maintenance nothing asked for — on 16 external call sites including cron
   * sweeps. It was caught by `project-data-storage-safety.test.ts`, whose
   * grouped-FTS cleanup candidate the unrequested alarm consumed before the test
   * could measure it (.claude/rules/47).
   */
  it('does not schedule an alarm when a terminal stop releases nothing', async () => {
    const { stub, chatSessionId } = await seedWorkingSession('term-noalarm-1');

    const alarmBefore = await runInDurableObject(stub, (instance: ProjectData) =>
      (instance as unknown as { ctx: DurableObjectState }).ctx.storage.getAlarm()
    );

    await stub.stopSession(chatSessionId);

    const alarmAfter = await runInDurableObject(stub, (instance: ProjectData) =>
      (instance as unknown as { ctx: DurableObjectState }).ctx.storage.getAlarm()
    );
    expect(alarmAfter).toBe(alarmBefore);
  });

  it('DOES recompute the alarm when the stop actually releases a delivery', async () => {
    // The discriminating control for the test above: without it, "no alarm was
    // scheduled" would also pass if the fan-out stopped recomputing entirely and
    // a released delivery were left with nothing to run it.
    const { stub, chatSessionId } = await seedWorkingSession('term-noalarm-2');
    const parkedUntil = Date.now() + 30 * 60 * 1000;
    const readNextAttempt = await queueBlockedDelivery(stub, chatSessionId, parkedUntil);
    expect(await readNextAttempt()).toBe(parkedUntil);

    await stub.stopSession(chatSessionId);

    const alarmAfter = await runInDurableObject(stub, (instance: ProjectData) =>
      (instance as unknown as { ctx: DurableObjectState }).ctx.storage.getAlarm()
    );
    expect(alarmAfter).not.toBeNull();
    expect(await readNextAttempt()).toBeLessThan(parkedUntil);
  });

  it('a mirror write failure never turns a successful stop into a failed one', async () => {
    const { stub, chatSessionId } = await seedWorkingSession('term-stop-4');

    // Force the fan-out to throw from inside the object, then assert the stop
    // still reports success and the durable session status still moved. The
    // probe sweep remains the backstop for the mirror.
    await runInDurableObject(stub, async (instance: ProjectData) => {
      const broken = instance as unknown as { recalculateAlarm: () => Promise<void> };
      const original = broken.recalculateAlarm.bind(instance);
      broken.recalculateAlarm = async () => {
        throw new Error('alarm recalculation exploded');
      };
      try {
        await expect(instance.stopSession(chatSessionId)).resolves.toBe(true);
      } finally {
        broken.recalculateAlarm = original;
      }
    });

    const session = await stub.getSession(chatSessionId);
    expect(session?.status).toBe('stopped');
  });
});
