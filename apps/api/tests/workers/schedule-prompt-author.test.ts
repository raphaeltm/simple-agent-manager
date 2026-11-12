/**
 * Constitution XV for scheduled messages, through the real create paths and the real due-schedule
 * alarm: an agent-written prompt reaches the chat only as a SAM notice naming the schedule, while
 * a person's prompt and SAM's own fixed continuation text are still delivered as written.
 */
import type { ProjectSchedule, ProjectScheduleMutationResult } from '@simple-agent-manager/shared';
import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { runScheduleAlarm } from '@simple-agent-manager/project-data/internal/do/project-event-schedules-runner';
import type { Env } from '../../src/env';
import * as service from '../../src/services/project-data';
import { body, fixture } from './helpers/event-channels';

const testEnv = env as unknown as Env;
const PROMPT = 'agent-note-that-must-not-reach-the-chat-as-plain-text';

type Fixture = Awaited<ReturnType<typeof fixture>>;

function request(sessionId: string, prompt = PROMPT) {
  return {
    action: { kind: 'message_session', sessionId, prompt },
    dueAt: Date.now() + 3_600_000,
    displayTimezone: 'UTC',
    idempotencyKey: crypto.randomUUID(),
  };
}

/** Make the schedule due and run the alarm the way ProjectData does; return what was queued. */
async function admit(f: Fixture, schedule: ProjectSchedule) {
  return runInDurableObject(f.stub, async (instance, state) => {
    state.storage.sql.exec(
      'UPDATE project_schedules SET due_at = ?, next_attempt_at = ? WHERE id = ?',
      Date.now() - 1,
      Date.now() - 1,
      schedule.id
    );
    await runScheduleAlarm(state.storage.sql, testEnv, {
      getProjectId: () => f.projectId,
      transactionSync: (callback) => state.storage.transactionSync(callback),
      waitUntil: () => {},
      recalculateAlarm: async () => {},
      scheduleSummarySync: () => {},
      broadcastEvent: () => {},
    });
    const admitted = await instance.getProjectSchedule({
      projectId: f.projectId,
      userId: f.userId,
      id: schedule.id,
    });
    const inbox = state.storage.sql
      .exec('SELECT content FROM session_inbox WHERE id = ?', admitted?.deliveryId ?? '')
      .toArray()[0] as { content: string } | undefined;
    const transcript = state.storage.sql
      .exec('SELECT role, content FROM chat_messages WHERE session_id = ?', f.sessionId)
      .toArray() as Array<{ role: string; content: string }>;
    return { admitted, inbox, transcript };
  });
}

describe('scheduled messages respect who wrote them', () => {
  it('delivers an agent-created schedule as a SAM notice the agent can follow', async () => {
    const f = await fixture();
    const created = body<ProjectScheduleMutationResult>(
      await f.tool('create_project_schedule', request(f.sessionId))
    );
    expect(created.schedule.promptAuthor).toBe('agent');

    const { admitted, inbox, transcript } = await admit(f, created.schedule);
    expect(admitted?.state).toBe('admitted');
    expect(inbox?.content).toMatch(/^SAM notice \(system-generated, not a human message\)/);
    expect(inbox?.content).toContain(created.schedule.id);
    expect(inbox?.content).not.toContain(PROMPT);
    // Liveness: the notice reached the transcript, and the prompt text did not.
    expect(transcript.some((row) => row.content === inbox?.content)).toBe(true);
    expect(transcript.some((row) => row.content.includes(PROMPT))).toBe(false);

    // The note is still there for the agent, through the tool the notice names.
    const read = body<{ schedule: ProjectSchedule }>(
      await f.tool('get_project_schedule', { scheduleId: created.schedule.id })
    );
    expect(read.schedule.action).toMatchObject({ prompt: PROMPT });
  });

  it.each([
    ['human', 'person'],
    ['sam', 'system'],
  ] as const)(
    'still delivers a %s-written prompt as written (control)',
    async (promptAuthor, creator) => {
      const f = await fixture();
      const prompt = `${promptAuthor} wrote this reminder`;
      const created = await service.createProjectSchedule(testEnv, f.projectId, {
        userId: f.userId,
        creatorChatSessionId: promptAuthor === 'sam' ? f.sessionId : null,
        creator,
        promptAuthor,
        request: request(f.sessionId, prompt),
      });
      expect(created.schedule.promptAuthor).toBe(promptAuthor);

      const { inbox, transcript } = await admit(f, created.schedule);
      expect(inbox?.content).toBe(prompt);
      expect(transcript.some((row) => row.content === prompt)).toBe(true);
    }
  );
});
