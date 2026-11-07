/**
 * Constitution XV, end to end in the Workers runtime: a real `send_durable_message`, the pair
 * channel, the wake materializer and the recipient's transcript. Whatever the delivery intent
 * or urgency, the recipient's chat holds only SAM's IDs-only notice, never the peer's words.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  type ChannelReceipt,
  okBody,
  sqlRows,
  twoAgentProject,
  withAgentMessageChannels,
} from './helpers/agent-message-channels';
import {
  materialize,
  wakeBatches,
  type WakeFixture,
  withQuietAlarms,
} from './helpers/event-wake-harness';

const PEER_TEXT = 'peer-text-that-must-never-reach-the-chat';

type InboxNotice = {
  id: string;
  content: string;
  message_class: string;
  delivery_intent: string;
};

/**
 * Materialize the recipient's wake with background alarms off, so nothing tries to deliver to
 * the seeded, unreachable VM; the test reads what would be delivered.
 */
function recipientState(f: WakeFixture) {
  return withQuietAlarms(f, () => readRecipientState(f));
}

async function readRecipientState(f: WakeFixture) {
  await materialize(f, Date.now());
  const batches = await wakeBatches(f, f.b.sessionId);
  const inbox = await sqlRows<InboxNotice>(
    f.stub,
    `SELECT id, content, message_class, delivery_intent FROM session_inbox
     WHERE target_session_id = ? ORDER BY created_at, id`,
    f.b.sessionId
  );
  const transcript = await sqlRows<{ role: string; content: string }>(
    f.stub,
    'SELECT role, content FROM chat_messages WHERE session_id = ? ORDER BY created_at, id',
    f.b.sessionId
  );
  return { batches, inbox, transcript };
}

function expectOnlyNotices(state: Awaited<ReturnType<typeof readRecipientState>>) {
  // Liveness: something was delivered, so the absence check below means something.
  expect(state.inbox.length).toBeGreaterThan(0);
  for (const row of state.inbox) {
    expect(row.content).toMatch(/^SAM notice \(system-generated, not a human message\)/);
    expect(row.content).not.toContain(PEER_TEXT);
  }
  for (const row of state.transcript) expect(row.content).not.toContain(PEER_TEXT);
}

describe('agent text reaches another agent only as a pointer', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends a steer over the pair channel; the recipient chat gets only the notice', async () => {
    await withAgentMessageChannels(async () => {
      const f = await twoAgentProject();
      const receipt = okBody<ChannelReceipt>(
        await f.a.tool('send_durable_message', {
          targetTaskId: f.b.taskId,
          message: PEER_TEXT,
          deliveryIntent: 'steer',
        })
      );
      expect(receipt.transport).toBe('agent_message_channel');

      const state = await recipientState(f);
      expect(state.batches).toHaveLength(1);
      expect(state.inbox).toEqual([
        expect.objectContaining({ message_class: 'deliver', delivery_intent: 'steer' }),
      ]);
      expect(state.inbox[0]!.content).toContain(receipt.eventId);
      expectOnlyNotices(state);

      // The text is still there for the recipient to read, through the event.
      const read = okBody<{ event: { metadata: { message: string } } }>(
        await f.b.tool('get_event', { eventId: receipt.eventId })
      );
      expect(read.event.metadata.message).toBe(PEER_TEXT);
    });
  });

  it.each(['interrupt', 'preempt_and_replan', 'shutdown_with_final_prompt'] as const)(
    'delivers an urgent %s message stop-and-deliver, still only as the notice',
    async (messageClass) => {
      await withAgentMessageChannels(async () => {
        const f = await twoAgentProject();
        const receipt = okBody<ChannelReceipt>(
          await f.a.tool('send_durable_message', {
            targetTaskId: f.b.taskId,
            message: PEER_TEXT,
            messageClass,
          })
        );

        const state = await recipientState(f);
        expect(state.inbox).toEqual([
          expect.objectContaining({ message_class: messageClass, delivery_intent: 'queue' }),
        ]);
        expect(state.inbox[0]!.content).toContain(`includes a ${messageClass} message`);
        expect(state.inbox[0]!.content).toContain(receipt.eventId);
        expectOnlyNotices(state);
      });
    }
  );

  it('keeps an ordinary message from stopping the turn (control)', async () => {
    await withAgentMessageChannels(async () => {
      const f = await twoAgentProject();
      okBody<ChannelReceipt>(
        await f.a.tool('send_durable_message', {
          targetTaskId: f.b.taskId,
          message: PEER_TEXT,
          messageClass: 'notify',
        })
      );
      const state = await recipientState(f);
      expect(state.inbox).toEqual([
        expect.objectContaining({ message_class: 'deliver', delivery_intent: 'steer' }),
      ]);
      expect(state.inbox[0]!.content).not.toContain('stopped your current turn');
      expectOnlyNotices(state);
    });
  });

  it('refuses the send, and writes nothing to the recipient, when channels are off', async () => {
    await withAgentMessageChannels(
      async () => {
        const f = await twoAgentProject();
        for (const args of [
          { targetTaskId: f.b.taskId, message: PEER_TEXT, deliveryIntent: 'steer' },
          { targetTaskId: f.b.taskId, message: PEER_TEXT, messageClass: 'interrupt' },
        ]) {
          const reply = await f.a.tool('send_durable_message', args);
          expect(reply.error?.message).toContain('Agent messaging is unavailable');
        }
        const reply = await f.a.tool('send_message_to_subtask', {
          taskId: f.b.taskId,
          message: PEER_TEXT,
        });
        expect(reply.error?.message).toContain('Agent messaging is unavailable');

        const inbox = await sqlRows(
          f.stub,
          'SELECT id FROM session_inbox WHERE target_session_id = ?',
          f.b.sessionId
        );
        const transcript = await sqlRows<{ content: string }>(
          f.stub,
          'SELECT content FROM chat_messages WHERE session_id = ?',
          f.b.sessionId
        );
        expect(inbox).toEqual([]);
        expect(transcript.some((row) => row.content.includes(PEER_TEXT))).toBe(false);
      },
      { AGENT_MESSAGE_CHANNELS_ENABLED: 'false' }
    );
  });
});
