import { assertGroundedOperatorResponse, OperatorGroundingError } from './grounding';
import type { OperatorAction, OperatorStore, OperatorTurn } from './store';

type Message = { role: 'user'; content: string } | { role: 'assistant'; content: string };
interface Group {
  turn: OperatorTurn | null;
  messages: Message[];
  actions: OperatorAction[];
  assistantOmitted: boolean;
  /** When the group's first message was stored, so the model can tell old history from now. */
  recordedAt: string | null;
}

/** SQLite `datetime('now')` text is UTC without a zone marker. */
function utcIso(value: string | null): string | null {
  if (!value) return null;
  const zoned = /(?:z|[+-]\d\d:?\d\d)$/i.test(value);
  const parsed = Date.parse(`${value.replace(' ', 'T')}${zoned ? '' : 'Z'}`);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

/**
 * Read-only model projection. Canonical messages/FTS stay untouched; historical
 * status references are neither fabricated tool results nor current authority.
 */
export function projectOperatorContext(input: {
  store: OperatorStore;
  turn: OperatorTurn;
  appOrigin: string;
  limit: number;
  maxBytes: number;
  maxActionRefs?: number;
}): { messages: Message[]; bytes: number } {
  const { store, turn, appOrigin } = input;
  const groups: Group[] = [];
  const bytes = (value: string) => new TextEncoder().encode(value).byteLength;
  const knownGroups = new Map<string, Group>();
  const sourceTurns = new Map<string, OperatorTurn | null>();
  // Fork IDs retain the original server-generated message ID at their tail.
  // Never infer provenance from message text or accept a suffix with another role.
  const sourceId = /^(?:fork:[0-9a-f-]{36}:)*operator:([0-9a-f-]{36}):(user|assistant)$/i;
  for (const entry of store.contextEntries(input.limit)) {
    const match = entry.id.match(sourceId);
    const id = match?.[2] === entry.role ? match[1] : undefined;
    if (id === turn.id) continue; // Explicit current request is appended exactly once below.
    if (id && !sourceTurns.has(id)) sourceTurns.set(id, store.turn(id));
    const candidate = id ? sourceTurns.get(id) : null;
    const source =
      candidate && store.hasContextSource(candidate, entry.role, entry.content) ? candidate : null;
    let group = source ? knownGroups.get(source.id) : undefined;
    if (!group) {
      // Unmapped legacy replies can belong only to an adjacent legacy user group.
      const previous = groups.at(-1);
      if (!source && entry.role === 'assistant' && previous && !previous.turn) group = previous;
      else {
        group = {
          turn: source,
          messages: [],
          actions: source ? store.actions(source.id) : [],
          assistantOmitted: false,
          recordedAt: utcIso(entry.createdAt),
        };
        groups.push(group);
        if (source) knownGroups.set(source.id, group);
      }
    }
    if (entry.role === 'assistant' && bytes(entry.content) > input.maxBytes)
      group.assistantOmitted = true;
    else group.messages.push({ role: entry.role, content: entry.content });
  }
  const projectGroup = (group: Group): Message[] => [
    ...group.messages.filter((message) => message.role === 'user'),
    {
      role: 'assistant',
      content: JSON.stringify({
        kind: 'sam_historical_turn_status',
        authority: 'historical_evidence_only',
        recordedAt: group.recordedAt,
        turnId: group.turn?.id ?? null,
        state: group.turn?.state ?? 'unknown',
        assistantOmitted: group.assistantOmitted,
        assistantMessages: group.messages
          .filter((message) => message.role === 'assistant')
          .map((message) => message.content),
        actions: group.actions
          .slice(0, input.maxActionRefs ?? input.limit)
          .map(({ id, operation, state }) => ({ id, operation, state })),
        actionsTruncated: group.actions.length > (input.maxActionRefs ?? input.limit),
      }),
    },
  ];
  const history = groups.filter((group) =>
    group.messages.some((message) => message.role === 'user')
  );
  const current: Message = { role: 'user', content: turn.message };
  const size = (messages: Message[]) => bytes(JSON.stringify(messages));
  if (size([current]) > input.maxBytes)
    throw new Error('SAM current request exceeds the context byte budget');
  const project = () => [...history.flatMap(projectGroup), current];
  while (history.length && size(project()) > input.maxBytes) {
    history.shift(); // Never separate a historical user from its status/assistant group.
  }
  // Bound the candidates before running the publication guard. Historical
  // malformed/unsupported prose must not poison every future turn.
  for (const group of history)
    group.messages = group.messages.filter((message) => {
      if (message.role === 'user') return true;
      try {
        assertGroundedOperatorResponse(message.content, group.actions, appOrigin);
        return true;
      } catch (error) {
        if (!(
          error instanceof OperatorGroundingError ||
          error instanceof TypeError ||
          error instanceof SyntaxError
        ))
          throw error;
        group.assistantOmitted = true;
        return false;
      }
    });
  const messages = project();
  return { messages, bytes: size(messages) };
}
