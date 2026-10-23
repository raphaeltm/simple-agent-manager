/**
 * `mergedRowAliases` against the chat's real conversion pipeline
 * (`chatMessagesToConversationItems` → `groupToolCallItems`), so a change to how rows merge
 * shows up here rather than as a comment that no longer lands.
 */
import { describe, expect, it } from 'vitest';

import {
  mergedRowAliases,
  renderedItemIds,
} from '../../../src/components/project-message-view/message-aliases';
import { groupToolCallItems } from '../../../src/components/project-message-view/tool-call-groups';
import { chatMessagesToConversationItems } from '../../../src/components/project-message-view/types';
import type { ChatMessageResponse } from '../../../src/lib/api';

let sequence = 0;
function row(
  id: string,
  role: string,
  content = `${id} `,
  toolMetadata: Record<string, unknown> | null = null
): ChatMessageResponse {
  sequence += 1;
  return {
    id,
    sessionId: 's1',
    role,
    content,
    toolMetadata,
    createdAt: 1_000 + sequence,
    sequence,
  };
}

function aliasesFor(rows: ChatMessageResponse[]) {
  const items = groupToolCallItems(chatMessagesToConversationItems(rows));
  return { items, aliases: mergedRowAliases(rows, items) };
}

describe('mergedRowAliases', () => {
  it('maps every later chunk of a streamed reply to the reply, which keeps its first id', () => {
    const { items, aliases } = aliasesFor([
      row('u1', 'user'),
      row('a1', 'assistant', 'It retries '),
      row('a2', 'assistant', 'because '),
      row('a3', 'assistant', 'of 500s.'),
      row('u2', 'user'),
    ]);

    expect(items.map((item) => item.id)).toEqual(['u1', 'a1', 'u2']);
    expect(Object.fromEntries(aliases)).toEqual({ a2: 'a1', a3: 'a1' });
  });

  it('starts a new reply after another message, so nothing is aliased across it', () => {
    const { aliases } = aliasesFor([
      row('a1', 'assistant'),
      row('u1', 'user'),
      row('a2', 'assistant'),
    ]);

    expect(aliases.size).toBe(0);
  });

  it('follows a reply across a tool-call update, which the chat merges in place', () => {
    const call = { toolCallId: 'call-1', title: 'Read file', kind: 'read', status: 'pending' };
    const { items, aliases } = aliasesFor([
      row('t1', 'tool', '', call),
      row('a1', 'assistant', 'Reading. '),
      row('t1-done', 'tool', '', { toolCallId: 'call-1', status: 'completed' }),
      row('a2', 'assistant', 'Done.'),
    ]);

    // The update row merged into the call; the reply continued across it.
    const reply = items.find((item) => item.kind === 'agent_message');
    expect(reply).toMatchObject({ id: 'a1', text: 'Reading. Done.' });
    expect(aliases.get('a2')).toBe('a1');
    expect(aliases.has('t1-done')).toBe(false);
  });

  it('maps a later thought chunk to the thought, also when the thought is folded into a tool group', () => {
    const { items, aliases } = aliasesFor([
      row('th1', 'thinking', 'Let me '),
      row('th2', 'thinking', 'check.'),
      row('t1', 'tool', '', { toolCallId: 'call-1', title: 'Run tests', kind: 'execute' }),
      row('a1', 'assistant', 'All green.'),
    ]);

    const group = items[0];
    expect(group?.kind).toBe('tool_call_group');
    expect(renderedItemIds(items).has('th1')).toBe(true);
    expect(aliases.get('th2')).toBe('th1');
  });
});
