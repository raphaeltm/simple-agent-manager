import { describe, expect, it, vi } from 'vitest';

import type { Json, Turn } from '../playwright/staging-sam-dispatch-evidence';
import {
  correlatedFollowupAnswer,
  followupDelivery,
  verifyCompletedFollowupReplay,
} from '../playwright/staging-sam-dispatch-followup';

const delivery = {
  messageId: 'followup-message',
  deliveryId: 'delivery',
  marker: 'RUN follow-up:',
  acknowledgement: 'RUN_FOLLOWUP_ACK',
};
const user = { id: delivery.messageId, role: 'user', content: `${delivery.marker} answer please` };
const answer = {
  id: 'answer',
  role: 'assistant',
  content: `${delivery.acknowledgement} src/main.ts`,
};
const check = (condition: boolean, label: string) => {
  if (!condition) throw new Error(label);
};
function turn(): Turn {
  return {
    id: 'turn',
    request_key: 'key',
    state: 'completed',
    response: 'Queued the follow-up.',
    actions: [
      {
        id: 'send',
        operation: 'sam_chat_send',
        state: 'completed',
        input_json: JSON.stringify({
          content: `${delivery.marker} Begin with ${delivery.acknowledgement}`,
        }),
        result_json: JSON.stringify({
          accepted: true,
          status: 'queued',
          messageId: delivery.messageId,
          deliveryId: delivery.deliveryId,
        }),
      },
    ],
  };
}

describe('follow-up semantic consumption correlation', () => {
  it('requires the delivered user ID and marker before a new acknowledged answer', () => {
    expect(correlatedFollowupAnswer([user, answer], delivery, new Set())).toEqual({
      id: 'answer',
      content: answer.content,
    });
  });
  it('reconstructs streamed assistant chunks without requiring a single complete row', () => {
    expect(
      correlatedFollowupAnswer(
        [
          user,
          { ...answer, content: 'RUN_FOLLOW' },
          { id: 'chunk', role: 'assistant', content: 'UP_ACK src/main.ts' },
        ],
        delivery,
        new Set()
      )
    ).toEqual({ id: 'answer', content: answer.content });
  });
  it.each(
    [
      [answer, user],
      [{ ...user, id: 'another-message' }, answer],
      [{ ...user, content: 'different request' }, answer],
      [user, { ...answer, content: 'Unrelated late initial report' }],
      [user, { id: 'intervening', role: 'user', content: 'Other question' }, answer],
      [{ ...user, role: 'assistant' }, answer],
    ].map((messages) => ({ messages }))
  )('does not mistake another prompt or answer for follow-up consumption: %j', ({ messages }) => {
    expect(correlatedFollowupAnswer(messages, delivery, new Set())).toBeNull();
  });
  it.each(['answer', delivery.messageId])('rejects an already observed %s', (id) => {
    expect(correlatedFollowupAnswer([user, answer], delivery, new Set([id]))).toBeNull();
  });
  it('requires concrete queued delivery identities and the exact acknowledgement instruction', () => {
    expect(followupDelivery(turn(), delivery.marker, delivery.acknowledgement, check)).toEqual(
      delivery
    );
    for (const result of [
      { accepted: true, status: 'queued' },
      { accepted: false, status: 'queued', messageId: 'm', deliveryId: 'd' },
      { accepted: true, status: 'unknown', messageId: 'm', deliveryId: 'd' },
    ]) {
      const candidate = turn();
      candidate.actions[0]!.result_json = JSON.stringify(result);
      expect(() =>
        followupDelivery(candidate, delivery.marker, delivery.acknowledgement, check)
      ).toThrow();
    }
    const candidate = turn();
    candidate.actions[0]!.input_json = JSON.stringify({ content: delivery.marker });
    expect(() =>
      followupDelivery(candidate, delivery.marker, delivery.acknowledgement, check)
    ).toThrow();
  });
});

describe('completed follow-up replay evidence', () => {
  function fixture() {
    const original = turn();
    const ledger: Json = {
      receipts: [{ id: 'send', operation: 'sam_chat_send', state: 'completed' }],
    };
    const current = structuredClone(original);
    return {
      turn: original,
      intent: { id: 'turn', key: 'key', message: 'Original exact intent' },
      ledger,
      samApi: 'https://api.test/sam',
      check,
      get: vi.fn().mockResolvedValue({ turns: [current] }),
      post: vi.fn().mockResolvedValue({ replayed: true, turn: current }),
      record: vi.fn(async (rows: Turn[]) => rows),
      save: vi.fn(async () => {}),
      current,
    };
  }
  it('reuses the same key and message and records immutable successful receipts', async () => {
    const input = fixture();
    await verifyCompletedFollowupReplay(input);
    expect(input.post).toHaveBeenCalledOnce();
    expect(input.post).toHaveBeenCalledWith('https://api.test/sam/turns', {
      requestKey: 'key',
      message: 'Original exact intent',
    });
    expect(input.ledger.followupReplay).toMatchObject({
      sameCompletedTurn: true,
      unchangedReceipts: true,
    });
    expect(input.save).toHaveBeenCalledOnce();
  });
  it.each(['state', 'answer', 'receipt', 'extra-action', 'new-turn'])(
    'rejects a replay that changes %s',
    async (change) => {
      const input = fixture();
      if (change === 'state') input.current.state = 'interrupted';
      if (change === 'answer') input.current.response = 'Changed';
      if (change === 'receipt') input.current.actions[0]!.result_json = '{}';
      if (change === 'extra-action') input.ledger.receipts.push({ id: 'unrelated' });
      if (change === 'new-turn') input.current.id = 'different';
      // An extra receipt appearing during observation must fail the aggregate invariant.
      if (change === 'extra-action')
        input.record.mockImplementationOnce(async (rows) => {
          input.ledger.receipts.push({ id: 'another-send' });
          return rows;
        });
      await expect(verifyCompletedFollowupReplay(input)).rejects.toThrow();
      expect(input.ledger.followupReplay).toBeUndefined();
    }
  );
});
