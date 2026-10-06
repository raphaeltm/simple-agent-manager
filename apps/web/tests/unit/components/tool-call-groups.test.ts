import type {
  ConversationItem,
  ThinkingItem,
  ToolCallItem,
} from '@simple-agent-manager/acp-client';
import { describe, expect, it } from 'vitest';

import type { ToolCallGroupItem } from '../../../src/components/project-message-view/tool-call-groups';
import {
  groupToolCallItems,
  summarizeToolCallGroup,
} from '../../../src/components/project-message-view/tool-call-groups';

function toolCall(overrides: Partial<ToolCallItem> & { id: string }): ToolCallItem {
  return {
    kind: 'tool_call',
    toolCallId: `tc-${overrides.id}`,
    title: `Bash: ${overrides.id}`,
    status: 'completed',
    content: [],
    locations: [],
    timestamp: 1_000,
    ...overrides,
  };
}

function thinking(overrides: Partial<ThinkingItem> & { id: string }): ThinkingItem {
  return {
    kind: 'thinking',
    text: 'reasoning…',
    active: false,
    timestamp: 1_000,
    ...overrides,
  };
}

function agentMessage(id: string, timestamp = 1_000): ConversationItem {
  return { kind: 'agent_message', id, text: `text ${id}`, streaming: false, timestamp };
}

/**
 * A typed document card: `display_from_library` with a resolvable fileId, which
 * is what makes `matchToolCard` return `DocumentCard` rather than null.
 */
function documentCardCall(id: string, timestamp = 1_000): ToolCallItem {
  return toolCall({
    id,
    timestamp,
    title: 'display_from_library',
    toolName: 'mcp__sam-mcp__display_from_library',
    rawInput: { fileId: 'file-123' },
  });
}

function expectGroup(item: ConversationItem | ToolCallGroupItem): ToolCallGroupItem {
  expect(item.kind).toBe('tool_call_group');
  return item as ToolCallGroupItem;
}

describe('groupToolCallItems', () => {
  it('returns an empty array for empty input', () => {
    expect(groupToolCallItems([])).toEqual([]);
  });

  it('merges consecutive tool calls into one group', () => {
    const display = groupToolCallItems([
      toolCall({ id: 't1', timestamp: 10 }),
      toolCall({ id: 't2', timestamp: 20 }),
      toolCall({ id: 't3', timestamp: 30 }),
    ]);

    expect(display).toHaveLength(1);
    const group = expectGroup(display[0]!);
    expect(group.items.map((i) => i.id)).toEqual(['t1', 't2', 't3']);
  });

  it('uses the first absorbed item id and timestamp as the group identity', () => {
    const display = groupToolCallItems([
      toolCall({ id: 't1', timestamp: 111 }),
      toolCall({ id: 't2', timestamp: 222 }),
    ]);

    const group = expectGroup(display[0]!);
    expect(group.id).toBe('t1');
    expect(group.timestamp).toBe(111);
  });

  it('breaks the run on agent text and keeps the text standalone', () => {
    const display = groupToolCallItems([
      toolCall({ id: 't1' }),
      agentMessage('a1'),
      toolCall({ id: 't2' }),
      toolCall({ id: 't3' }),
    ]);

    expect(display.map((i) => i.kind)).toEqual([
      'tool_call_group',
      'agent_message',
      'tool_call_group',
    ]);
    expect(expectGroup(display[0]!).items.map((i) => i.id)).toEqual(['t1']);
    expect(expectGroup(display[2]!).items.map((i) => i.id)).toEqual(['t2', 't3']);
  });

  it('never absorbs a typed document card — it breaks the run and stays standalone', () => {
    const display = groupToolCallItems([
      toolCall({ id: 't1' }),
      documentCardCall('doc1'),
      toolCall({ id: 't2' }),
    ]);

    expect(display.map((i) => i.kind)).toEqual(['tool_call_group', 'tool_call', 'tool_call_group']);
    expect(display[1]!.id).toBe('doc1');
  });

  it('absorbs thinking blocks interleaved between tool calls', () => {
    const display = groupToolCallItems([
      thinking({ id: 'k1' }),
      toolCall({ id: 't1' }),
      thinking({ id: 'k2' }),
      toolCall({ id: 't2' }),
    ]);

    expect(display).toHaveLength(1);
    const group = expectGroup(display[0]!);
    expect(group.items.map((i) => i.id)).toEqual(['k1', 't1', 'k2', 't2']);
    // Identity comes from the first absorbed item, even when it is a thinking block.
    expect(group.id).toBe('k1');
  });

  it('leaves a thinking-only run untouched', () => {
    const display = groupToolCallItems([thinking({ id: 'k1' }), thinking({ id: 'k2' })]);

    expect(display.map((i) => i.kind)).toEqual(['thinking', 'thinking']);
    expect(display.map((i) => i.id)).toEqual(['k1', 'k2']);
  });

  it('groups a single tool call (a group of 1)', () => {
    const display = groupToolCallItems([agentMessage('a1'), toolCall({ id: 't1' })]);

    expect(display.map((i) => i.kind)).toEqual(['agent_message', 'tool_call_group']);
    expect(expectGroup(display[1]!).items).toHaveLength(1);
  });

  it('emits non-absorbable kinds unchanged and in order', () => {
    const items: ConversationItem[] = [
      { kind: 'user_message', id: 'u1', text: 'hi', timestamp: 1 },
      toolCall({ id: 't1' }),
      { kind: 'plan', id: 'p1', entries: [], timestamp: 2 },
      { kind: 'system_message', id: 's1', text: 'sys', timestamp: 3 },
      toolCall({ id: 't2' }),
      { kind: 'raw_fallback', id: 'r1', data: {}, timestamp: 4 },
    ];

    expect(groupToolCallItems(items).map((i) => i.kind)).toEqual([
      'user_message',
      'tool_call_group',
      'plan',
      'system_message',
      'tool_call_group',
      'raw_fallback',
    ]);
  });
});

describe('summarizeToolCallGroup', () => {
  function group(items: Array<ToolCallItem | ThinkingItem>): ToolCallGroupItem {
    return { kind: 'tool_call_group', id: items[0]!.id, items, timestamp: items[0]!.timestamp };
  }

  it('counts tool calls only, ignoring absorbed thinking blocks', () => {
    const summary = summarizeToolCallGroup(
      group([thinking({ id: 'k1' }), toolCall({ id: 't1' }), toolCall({ id: 't2' })])
    );

    expect(summary.toolCallCount).toBe(2);
    expect(summary.completedCount).toBe(2);
  });

  it('counts running, failed and completed calls separately', () => {
    const summary = summarizeToolCallGroup(
      group([
        toolCall({ id: 't1', status: 'completed' }),
        toolCall({ id: 't2', status: 'failed' }),
        toolCall({ id: 't3', status: 'failed' }),
        toolCall({ id: 't4', status: 'in_progress' }),
        toolCall({ id: 't5', status: 'pending' }),
      ])
    );

    expect(summary).toMatchObject({
      toolCallCount: 5,
      completedCount: 1,
      failedCount: 2,
      runningCount: 2,
    });
  });

  it('picks the NEWEST unfinished call as the live title', () => {
    const summary = summarizeToolCallGroup(
      group([
        toolCall({ id: 't1', status: 'in_progress', title: 'Bash: older' }),
        toolCall({ id: 't2', status: 'completed', title: 'Read: done' }),
        toolCall({ id: 't3', status: 'in_progress', title: 'Bash: newest' }),
      ])
    );

    expect(summary.liveKind).toBe('tool');
    expect(summary.liveTitle).toBe('Bash: newest');
  });

  it('reports liveKind "thinking" when the newest absorbed item is an active thinking block', () => {
    const summary = summarizeToolCallGroup(
      group([
        toolCall({ id: 't1', status: 'in_progress', title: 'Bash: running' }),
        thinking({ id: 'k1', active: true }),
      ])
    );

    expect(summary.liveKind).toBe('thinking');
    expect(summary.liveTitle).toBeUndefined();
    // The running count is still reported — only the live LABEL changes.
    expect(summary.runningCount).toBe(1);
  });

  it('reports no live state when every call has settled', () => {
    const summary = summarizeToolCallGroup(
      group([toolCall({ id: 't1' }), thinking({ id: 'k1', active: false })])
    );

    expect(summary.liveKind).toBeNull();
    expect(summary.liveTitle).toBeUndefined();
    expect(summary.runningCount).toBe(0);
  });
});
