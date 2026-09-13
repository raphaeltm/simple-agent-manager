import { describe, expect, it } from 'vitest';

import { collapseToolRuns } from '../../src/collapse-tool-runs';
import type { ConversationItem, ToolCallItem } from '../../src/hooks/useAcpMessages';

let clock = 0;

function toolCall(id: string, overrides: Partial<ToolCallItem> = {}): ToolCallItem {
  clock += 1;
  return {
    kind: 'tool_call',
    id,
    toolCallId: `tc-${id}`,
    title: 'Read',
    status: 'completed',
    content: [],
    locations: [],
    timestamp: clock,
    messageId: id,
    contentLoaded: false,
    ...overrides,
  };
}

function agentMessage(id: string, text: string): ConversationItem {
  clock += 1;
  return { kind: 'agent_message', id, text, streaming: false, timestamp: clock };
}

/** Every input item must survive the transform exactly once, flattened. */
function flatten(items: ConversationItem[]): string[] {
  return items.flatMap((item) =>
    item.kind === 'tool_call_group' ? item.calls.map((call) => call.id) : [item.id]
  );
}

describe('collapseToolRuns', () => {
  it('collapses a run of consecutive tool calls into one group keyed by the first call', () => {
    const items = [
      agentMessage('a1', 'Let me look.'),
      toolCall('t1'),
      toolCall('t2'),
      toolCall('t3'),
      agentMessage('a2', 'Found it.'),
    ];

    const result = collapseToolRuns(items);

    expect(result.map((item) => item.kind)).toEqual([
      'agent_message',
      'tool_call_group',
      'agent_message',
    ]);
    const group = result[1];
    if (group?.kind !== 'tool_call_group') throw new Error('expected a group');
    expect(group.id).toBe('t1');
    expect(group.calls.map((call) => call.id)).toEqual(['t1', 't2', 't3']);
  });

  it('leaves a lone tool call uncollapsed', () => {
    const items = [agentMessage('a1', 'One step.'), toolCall('t1'), agentMessage('a2', 'Done.')];
    expect(collapseToolRuns(items).map((item) => item.kind)).toEqual([
      'agent_message',
      'tool_call',
      'agent_message',
    ]);
  });

  it('breaks a run at a typed-card call so a displayed document is never hidden', () => {
    const document = toolCall('doc', { toolName: 'mcp__sam-mcp__display_from_library' });
    const items = [
      toolCall('t1'),
      toolCall('t2'),
      document,
      toolCall('t3'),
      toolCall('t4'),
    ];

    const result = collapseToolRuns(items, {
      isStandalone: (call) => call.id === 'doc',
    });

    expect(result.map((item) => item.kind)).toEqual([
      'tool_call_group',
      'tool_call',
      'tool_call_group',
    ]);
    expect(result[1]?.id).toBe('doc');
  });

  it('keeps every call individually addressable for lazy content loading', () => {
    const result = collapseToolRuns([toolCall('t1'), toolCall('t2')]);
    const group = result[0];
    if (group?.kind !== 'tool_call_group') throw new Error('expected a group');
    expect(group.calls.map((call) => call.messageId)).toEqual(['t1', 't2']);
  });

  it('preserves every item exactly once, in order', () => {
    const items = [
      agentMessage('a1', 'start'),
      toolCall('t1'),
      toolCall('t2'),
      agentMessage('a2', 'middle'),
      toolCall('t3'),
      { kind: 'thinking' as const, id: 'th1', text: 'hmm', active: false, timestamp: 99 },
      toolCall('t4'),
      toolCall('t5'),
      toolCall('t6'),
    ];

    expect(flatten(collapseToolRuns(items))).toEqual([
      'a1',
      't1',
      't2',
      'a2',
      't3',
      'th1',
      't4',
      't5',
      't6',
    ]);
  });

  it('handles an empty conversation and a conversation of only tool calls', () => {
    expect(collapseToolRuns([])).toEqual([]);
    const allTools = collapseToolRuns([toolCall('t1'), toolCall('t2'), toolCall('t3')]);
    expect(allTools).toHaveLength(1);
    expect(allTools[0]?.kind).toBe('tool_call_group');
  });

  it('honours a raised minimum run length', () => {
    const items = [toolCall('t1'), toolCall('t2')];
    expect(collapseToolRuns(items, { minRunLength: 3 }).map((item) => item.kind)).toEqual([
      'tool_call',
      'tool_call',
    ]);
  });
});
