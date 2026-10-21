import { createHash } from 'node:crypto';

import type { Json, Turn } from './staging-sam-dispatch-evidence';

type Check = (condition: boolean, label: string) => void;
export interface FollowupDelivery {
  messageId: string;
  deliveryId: string;
  marker: string;
  acknowledgement: string;
}

/** Match the persisted human message and only its subsequent assistant run. */
export function correlatedFollowupAnswer(
  messages: Json[],
  delivery: FollowupDelivery,
  previousIds: Set<string>
): { id: string; content: string } | null {
  const index = messages.findIndex(
    (message) =>
      message.id === delivery.messageId &&
      message.role === 'user' &&
      !previousIds.has(message.id) &&
      String(message.content ?? '').includes(delivery.marker)
  );
  if (index < 0) return null;
  const answers: Json[] = [];
  for (const message of messages.slice(index + 1)) {
    if (message.role === 'user') break;
    if (message.role === 'assistant' && !previousIds.has(message.id)) answers.push(message);
  }
  const content = answers.map((message) => String(message.content ?? '')).join('');
  return content.includes(delivery.acknowledgement) && answers[0]
    ? { id: answers[0].id, content }
    : null;
}

/** Capture server delivery identity; never infer consumption from queue acceptance. */
export function followupDelivery(
  turn: Turn,
  marker: string,
  acknowledgement: string,
  check: Check
): FollowupDelivery {
  const sends = turn.actions.filter(
    (action) => action.operation === 'sam_chat_send' && action.state === 'completed'
  );
  check(sends.length === 1, 'Exactly one completed follow-up delivery receipt');
  const result = JSON.parse(sends[0]?.result_json ?? '{}');
  const input = JSON.parse(sends[0]?.input_json ?? '{}');
  check(
    result.accepted === true &&
      result.status === 'queued' &&
      typeof result.messageId === 'string' &&
      result.messageId.length > 0 &&
      typeof result.deliveryId === 'string' &&
      result.deliveryId.length > 0 &&
      String(input.content ?? '').includes(marker) &&
      String(input.content ?? '').includes(acknowledgement),
    'Follow-up receipt retains exact queued message and acknowledgement instruction'
  );
  return { messageId: result.messageId, deliveryId: result.deliveryId, marker, acknowledgement };
}

export async function verifyCompletedFollowupReplay(input: {
  turn: Turn;
  intent: { id: string; key: string; message: string };
  ledger: Json;
  samApi: string;
  check: Check;
  get: (url: string) => Promise<Json>;
  post: (url: string, body: Json) => Promise<Json>;
  record: (turns: Turn[]) => Promise<Turn[]>;
  save: () => Promise<void>;
}) {
  const { turn, intent, check, ledger } = input;
  check(turn.state === 'completed', 'Successful follow-up replay starts from completed turn');
  const snapshot = JSON.stringify(turn.actions);
  const identities = JSON.stringify(ledger.receipts);
  const replay = await input.post(`${input.samApi}/turns`, {
    requestKey: intent.key,
    message: intent.message,
  });
  check(
    replay.replayed === true && replay.turn.id === turn.id && replay.turn.state === 'completed',
    'Same follow-up key replays the same completed turn'
  );
  const observed = await input.record((await input.get(`${input.samApi}/turns`)).turns);
  const current = observed.find((item) => item.id === turn.id);
  check(
    current?.state === 'completed' &&
      current.response === turn.response &&
      JSON.stringify(current.actions) === snapshot &&
      JSON.stringify(ledger.receipts) === identities,
    'Successful follow-up replay preserves answer and all action receipts without extra effects'
  );
  ledger.followupReplay = {
    turnId: turn.id,
    sameCompletedTurn: true,
    receiptSha256: createHash('sha256').update(snapshot).digest('hex'),
    unchangedReceipts: true,
  };
  await input.save();
}
