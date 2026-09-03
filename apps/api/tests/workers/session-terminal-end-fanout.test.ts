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

  it('stopSession CANCELS the idle cleanup schedule rather than re-arming it', async () => {
    const { stub, chatSessionId } = await seedWorkingSession('term-stop-2');
    await stub.scheduleIdleCleanup(chatSessionId, 'ws-1', null);
    expect(await stub.getCleanupAt(chatSessionId)).toBeGreaterThan(0);

    await stub.stopSession(chatSessionId);

    // A terminal session must not be handed a fresh idle timer — that is the
    // immortal-candidate anti-pattern (.claude/rules/47 §3). This is precisely
    // why the fan-out does not reuse `publishTurnEnd`, whose `armIdleCleanup`
    // hook calls `resetIdleCleanup`.
    expect(await stub.getCleanupAt(chatSessionId)).toBeNull();
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
