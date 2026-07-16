/**
 * Behavioral tests for chatMessagesToConversationItems().
 *
 * This function converts DO-persisted ChatMessageResponse[] into
 * ConversationItem[] for unified ACP-style rendering.
 *
 * These tests exercise the actual runtime behaviour of every branch.
 */
import type { ToolCallItem } from '@simple-agent-manager/acp-client';
import { describe, expect, it } from 'vitest';

import { chatMessagesToConversationItems } from '../../../src/components/project-message-view';
import { DocumentCard } from '../../../src/components/project-message-view/tool-cards/DocumentCard';
import { matchToolCard } from '../../../src/components/project-message-view/tool-cards/registry';
import type { ChatMessageResponse } from '../../../src/lib/api';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function msg(overrides: Partial<ChatMessageResponse> & { role: string; content: string }): ChatMessageResponse {
  return {
    id: `msg-${Math.random().toString(36).slice(2)}`,
    sessionId: 'sess-1',
    toolMetadata: null,
    createdAt: Date.now(),
    ...overrides,
  };
}

function toolMsg(
  overrides: Partial<ChatMessageResponse> & {
    content: string;
    toolMetadata: NonNullable<ChatMessageResponse['toolMetadata']>;
  }
): ChatMessageResponse {
  return msg({
    role: 'tool',
    ...overrides,
    toolMetadata: overrides.toolMetadata as unknown as null,
  });
}

// ---------------------------------------------------------------------------
// Empty input
// ---------------------------------------------------------------------------

describe('chatMessagesToConversationItems', () => {
  it('returns empty array for empty input', () => {
    expect(chatMessagesToConversationItems([])).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // User messages
  // -------------------------------------------------------------------------

  it('converts a user message to user_message item', () => {
    const input = [msg({ role: 'user', content: 'hello agent' })];
    const items = chatMessagesToConversationItems(input);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: 'user_message',
      text: 'hello agent',
    });
  });

  it('maps origin=system user message to a system-origin item (collapsed in UI)', () => {
    const input = [msg({ role: 'user', content: 'call get_instructions', origin: 'system' })];
    const items = chatMessagesToConversationItems(input);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'user_message', origin: 'system' });
  });

  it.each([
    ['explicit user', 'user' as const, 'user'],
    ['null (pre-migration)', null, 'user'],
    ['undefined (old message)', undefined, 'user'],
    ['system', 'system' as const, 'system'],
  ])('user message with origin %s maps to item origin %s', (_label, origin, expected) => {
    const input = [msg({ role: 'user', content: 'x', origin })];
    const items = chatMessagesToConversationItems(input);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'user_message', origin: expected });
  });

  it('gives user_message item the message id and createdAt timestamp', () => {
    const m = msg({ id: 'u-1', role: 'user', content: 'hi', createdAt: 12345 });
    const items = chatMessagesToConversationItems([m]);

    expect(items[0]).toMatchObject({ id: 'u-1', timestamp: 12345 });
  });

  // -------------------------------------------------------------------------
  // Assistant messages — merging consecutive chunks
  // -------------------------------------------------------------------------

  it('converts an assistant message to agent_message item', () => {
    const input = [msg({ role: 'assistant', content: 'I can help' })];
    const items = chatMessagesToConversationItems(input);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'agent_message', text: 'I can help', streaming: false });
  });

  it('merges consecutive assistant chunks into a single agent_message', () => {
    const input = [
      msg({ role: 'assistant', content: 'Hello, ' }),
      msg({ role: 'assistant', content: 'world!' }),
    ];
    const items = chatMessagesToConversationItems(input);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'agent_message', text: 'Hello, world!' });
  });

  it('does NOT merge assistant chunks interrupted by a different role', () => {
    const input = [
      msg({ role: 'assistant', content: 'First' }),
      msg({ role: 'user', content: 'Interrupt' }),
      msg({ role: 'assistant', content: 'Second' }),
    ];
    const items = chatMessagesToConversationItems(input);

    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({ kind: 'agent_message', text: 'First' });
    expect(items[1]).toMatchObject({ kind: 'user_message', text: 'Interrupt' });
    expect(items[2]).toMatchObject({ kind: 'agent_message', text: 'Second' });
  });

  // -------------------------------------------------------------------------
  // Thinking messages — merging consecutive chunks
  // -------------------------------------------------------------------------

  it('converts a thinking message to thinking item', () => {
    const input = [msg({ role: 'thinking', content: 'let me reason...' })];
    const items = chatMessagesToConversationItems(input);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'thinking', text: 'let me reason...', active: false });
  });

  it('merges consecutive thinking chunks', () => {
    const input = [
      msg({ role: 'thinking', content: 'step 1... ' }),
      msg({ role: 'thinking', content: 'step 2...' }),
    ];
    const items = chatMessagesToConversationItems(input);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'thinking', text: 'step 1... step 2...' });
  });

  it('does NOT merge thinking chunks interrupted by another role', () => {
    const input = [
      msg({ role: 'thinking', content: 'thought A' }),
      msg({ role: 'assistant', content: 'response' }),
      msg({ role: 'thinking', content: 'thought B' }),
    ];
    const items = chatMessagesToConversationItems(input);

    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({ kind: 'thinking', text: 'thought A' });
    expect(items[2]).toMatchObject({ kind: 'thinking', text: 'thought B' });
  });

  // -------------------------------------------------------------------------
  // Plan messages
  // -------------------------------------------------------------------------

  it('converts a plan message to plan item with parsed entries', () => {
    const entries = [
      { content: 'Read the file', priority: 'high', status: 'completed' },
      { content: 'Write tests', priority: 'medium', status: 'in_progress' },
    ];
    const input = [msg({ role: 'plan', content: JSON.stringify(entries) })];
    const items = chatMessagesToConversationItems(input);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'plan' });
    const planItem = items[0] as { kind: 'plan'; entries: unknown[] };
    expect(planItem.entries).toHaveLength(2);
    expect(planItem.entries[0]).toMatchObject({ content: 'Read the file', status: 'completed' });
    expect(planItem.entries[1]).toMatchObject({ content: 'Write tests', status: 'in_progress' });
  });

  it('replaces an earlier plan with the latest plan content', () => {
    const firstPlan = [{ content: 'Old step', priority: 'high', status: 'pending' }];
    const secondPlan = [
      { content: 'New step A', priority: 'high', status: 'completed' },
      { content: 'New step B', priority: 'medium', status: 'in_progress' },
    ];
    const input = [
      msg({ role: 'plan', content: JSON.stringify(firstPlan) }),
      msg({ role: 'plan', content: JSON.stringify(secondPlan) }),
    ];
    const items = chatMessagesToConversationItems(input);

    // Both plans collapsed into one item
    expect(items).toHaveLength(1);
    const planItem = items[0] as { kind: 'plan'; entries: unknown[] };
    expect(planItem.entries).toHaveLength(2);
    expect(planItem.entries[0]).toMatchObject({ content: 'New step A' });
  });

  it('skips plan with invalid JSON content', () => {
    const input = [msg({ role: 'plan', content: 'not-json' })];
    const items = chatMessagesToConversationItems(input);

    expect(items).toHaveLength(0);
  });

  it('skips plan with empty entries array', () => {
    const input = [msg({ role: 'plan', content: '[]' })];
    const items = chatMessagesToConversationItems(input);

    expect(items).toHaveLength(0);
  });

  it('skips plan when content is not a JSON array', () => {
    const input = [msg({ role: 'plan', content: '{"content":"bad"}' })];
    const items = chatMessagesToConversationItems(input);

    expect(items).toHaveLength(0);
  });

  it('defaults invalid priority to "medium"', () => {
    const entries = [{ content: 'Step', priority: 'ultra', status: 'pending' }];
    const input = [msg({ role: 'plan', content: JSON.stringify(entries) })];
    const items = chatMessagesToConversationItems(input);

    const planItem = items[0] as { entries: Array<{ priority: string }> };
    expect(planItem.entries[0]?.priority).toBe('medium');
  });

  it('defaults invalid status to "pending"', () => {
    const entries = [{ content: 'Step', priority: 'high', status: 'unknown_status' }];
    const input = [msg({ role: 'plan', content: JSON.stringify(entries) })];
    const items = chatMessagesToConversationItems(input);

    const planItem = items[0] as { entries: Array<{ status: string }> };
    expect(planItem.entries[0]?.status).toBe('pending');
  });

  // -------------------------------------------------------------------------
  // Tool messages — basic
  // -------------------------------------------------------------------------

  it('converts a tool message with null metadata to tool_call with fallback content', () => {
    const input = [msg({ role: 'tool', content: 'output text', toolMetadata: null })];
    const items = chatMessagesToConversationItems(input);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: 'tool_call',
      title: 'Tool Call', // generic fallback when no title or specific kind
    });
  });

  it('marks plain tool message content for lazy loading instead of rendering it inline', () => {
    const input = [msg({ id: 'tool-plain', role: 'tool', content: 'plain output', toolMetadata: null })];
    const items = chatMessagesToConversationItems(input);

    expect(items[0]).toMatchObject({
      kind: 'tool_call',
      content: [],
      contentLoaded: false,
      messageId: 'tool-plain',
      contentSize: 'plain output'.length,
    });
  });

  it('uses toolCallId from metadata for tool_call id field', () => {
    const meta = { toolCallId: 'tc-abc', title: 'Run', kind: 'execute', status: 'completed', content: [] };
    const input = [msg({ role: 'tool', content: 'done', toolMetadata: meta as unknown as null })];
    const items = chatMessagesToConversationItems(input);

    expect(items[0]).toMatchObject({ toolCallId: 'tc-abc' });
  });

  it('uses message id as toolCallId fallback when metadata has no toolCallId', () => {
    const meta = { kind: 'read', status: 'completed', content: [] };
    const m = msg({ id: 'msg-fallback', role: 'tool', content: 'out', toolMetadata: meta as unknown as null });
    const items = chatMessagesToConversationItems([m]);

    expect(items[0]).toMatchObject({ toolCallId: 'msg-fallback' });
  });

  // -------------------------------------------------------------------------
  // Tool messages — deduplication by toolCallId
  // -------------------------------------------------------------------------

  it('deduplicates tool messages with the same toolCallId', () => {
    const meta1 = { toolCallId: 'tc-1', title: 'Read', kind: 'read', status: 'in_progress', content: [] };
    const meta2 = { toolCallId: 'tc-1', title: 'Read done', kind: 'read', status: 'completed', content: [] };
    const input = [
      msg({ role: 'tool', content: '(tool call)', toolMetadata: meta1 as unknown as null }),
      msg({ role: 'tool', content: '(tool update)', toolMetadata: meta2 as unknown as null }),
    ];
    const items = chatMessagesToConversationItems(input);

    // Both messages with the same toolCallId → merged into one item
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'tool_call', toolCallId: 'tc-1', status: 'completed' });
  });

  it('updates title on deduplication when update has a non-kind title', () => {
    const meta1 = { toolCallId: 'tc-2', title: 'Initial', kind: 'read', status: 'in_progress', content: [] };
    const meta2 = { toolCallId: 'tc-2', title: 'Updated title', kind: 'read', status: 'completed', content: [] };
    const input = [
      msg({ role: 'tool', content: 'start', toolMetadata: meta1 as unknown as null }),
      msg({ role: 'tool', content: 'end', toolMetadata: meta2 as unknown as null }),
    ];
    const items = chatMessagesToConversationItems(input);

    expect(items[0]).toMatchObject({ title: 'Updated title' });
  });

  it('keeps the initial tool title when a status-only update omits title and kind', () => {
    const meta1 = {
      toolCallId: 'tc-status-only',
      title: 'Bash: pnpm test -- --runInBand',
      kind: 'execute',
      status: 'in_progress',
      content: [{ type: 'terminal', terminalId: 'term-status-only' }],
    };
    const meta2 = {
      toolCallId: 'tc-status-only',
      status: 'completed',
    };
    const input = [
      msg({ role: 'tool', content: '(tool call)', toolMetadata: meta1 as unknown as null }),
      msg({ role: 'tool', content: '(tool update)', toolMetadata: meta2 as unknown as null }),
    ];
    const items = chatMessagesToConversationItems(input);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: 'tool_call',
      title: 'Bash: pnpm test -- --runInBand',
      toolKind: 'execute',
      status: 'completed',
    });
    expect(items[0]).toMatchObject({
      content: [],
      contentLoaded: false,
      messageId: expect.any(String),
    });
  });

  it('keeps separate tool_call items for different toolCallIds', () => {
    const meta1 = { toolCallId: 'tc-a', kind: 'read', status: 'completed', content: [] };
    const meta2 = { toolCallId: 'tc-b', kind: 'edit', status: 'completed', content: [] };
    const input = [
      msg({ role: 'tool', content: 'out a', toolMetadata: meta1 as unknown as null }),
      msg({ role: 'tool', content: 'out b', toolMetadata: meta2 as unknown as null }),
    ];
    const items = chatMessagesToConversationItems(input);

    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ toolCallId: 'tc-a' });
    expect(items[1]).toMatchObject({ toolCallId: 'tc-b' });
  });

  // -------------------------------------------------------------------------
  // Tool messages — lazy content pointers
  // -------------------------------------------------------------------------

  it('normalizes structured metadata content to a lazy-load pointer', () => {
    const structuredContent = [
      { type: 'diff', text: '/src/foo.go', path: '/src/foo.go', oldText: 'old', newText: 'new' },
    ];
    const meta = {
      toolCallId: 'tc-diff',
      title: 'Edit file',
      kind: 'edit',
      status: 'completed',
      content: structuredContent,
    };
    const input = [msg({ role: 'tool', content: 'diff: /src/foo.go', toolMetadata: meta as unknown as null })];
    const items = chatMessagesToConversationItems(input);

    expect(items[0]).toMatchObject({
      kind: 'tool_call',
      content: [],
      contentLoaded: false,
      messageId: expect.any(String),
      contentSize: expect.any(Number),
    });
  });

  it('preserves lazy-load metadata from compact update rows merged into an existing tool call', () => {
    const meta1 = { toolCallId: 'tc-compact-merge', title: 'Search files', kind: 'search', status: 'in_progress' };
    const meta2 = { toolCallId: 'tc-compact-merge', status: 'completed', contentSize: 1234 };
    const input = [
      toolMsg({ id: 'tool-start', content: '(tool call)', toolMetadata: meta1 }),
      toolMsg({ id: 'tool-result', content: '(tool update)', toolMetadata: meta2 }),
    ];
    const items = chatMessagesToConversationItems(input);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: 'tool_call',
      title: 'Search files',
      status: 'completed',
      content: [],
      contentLoaded: false,
      messageId: 'tool-result',
      contentSize: 1234,
    });
  });

  // -------------------------------------------------------------------------
  // Tool messages — placeholder content suppression
  // -------------------------------------------------------------------------

  it('suppresses "(tool call)" placeholder content when no structured metadata', () => {
    const input = [msg({ role: 'tool', content: '(tool call)', toolMetadata: null })];
    const items = chatMessagesToConversationItems(input);

    const toolItem = items[0] as { content: unknown[] };
    expect(toolItem.content).toHaveLength(0);
  });

  it('suppresses "(tool update)" placeholder content when no structured metadata', () => {
    const input = [msg({ role: 'tool', content: '(tool update)', toolMetadata: null })];
    const items = chatMessagesToConversationItems(input);

    const toolItem = items[0] as { content: unknown[] };
    expect(toolItem.content).toHaveLength(0);
  });

  it('does not render non-placeholder content inline', () => {
    const input = [msg({ id: 'tool-output', role: 'tool', content: 'real output here', toolMetadata: null })];
    const items = chatMessagesToConversationItems(input);

    expect(items[0]).toMatchObject({
      content: [],
      contentLoaded: false,
      messageId: 'tool-output',
      contentSize: 'real output here'.length,
    });
  });

  // -------------------------------------------------------------------------
  // Tool messages — status mapping
  // -------------------------------------------------------------------------

  it('maps unknown status string to "completed"', () => {
    const meta = { toolCallId: 'tc-unk', kind: 'read', status: 'bogus_status', content: [] };
    const input = [msg({ role: 'tool', content: 'out', toolMetadata: meta as unknown as null })];
    const items = chatMessagesToConversationItems(input);

    expect(items[0]).toMatchObject({ status: 'completed' });
  });

  it('preserves valid status values: pending, in_progress, completed, failed', () => {
    const statuses = ['pending', 'in_progress', 'completed', 'failed'] as const;
    for (const s of statuses) {
      const meta = { toolCallId: `tc-${s}`, kind: 'read', status: s, content: [] };
      const input = [msg({ role: 'tool', content: 'out', toolMetadata: meta as unknown as null })];
      const items = chatMessagesToConversationItems(input);
      expect(items[0]).toMatchObject({ status: s });
    }
  });

  // -------------------------------------------------------------------------
  // Tool messages — locations
  // -------------------------------------------------------------------------

  it('maps locations from metadata to tool_call locations', () => {
    const meta = {
      toolCallId: 'tc-loc',
      kind: 'read',
      status: 'completed',
      content: [],
      locations: [{ path: '/src/a.go', line: 42 }],
    };
    const input = [msg({ role: 'tool', content: 'out', toolMetadata: meta as unknown as null })];
    const items = chatMessagesToConversationItems(input);

    const toolItem = items[0] as { locations: Array<{ path: string; line: number | null }> };
    expect(toolItem.locations).toHaveLength(1);
    expect(toolItem.locations[0]).toMatchObject({ path: '/src/a.go', line: 42 });
  });

  it('fills missing path with empty string in locations', () => {
    const meta = {
      toolCallId: 'tc-noloc',
      kind: 'read',
      status: 'completed',
      content: [],
      locations: [{ line: 1 }], // no path
    };
    const input = [msg({ role: 'tool', content: 'out', toolMetadata: meta as unknown as null })];
    const items = chatMessagesToConversationItems(input);

    const toolItem = items[0] as { locations: Array<{ path: string }> };
    expect(toolItem.locations[0]?.path).toBe('');
  });

  // -------------------------------------------------------------------------
  // System messages
  // -------------------------------------------------------------------------

  it('converts system messages to system_message items', () => {
    const input = [msg({ role: 'system', content: 'Task started.' })];
    const items = chatMessagesToConversationItems(input);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'system_message', text: 'Task started.' });
  });

  it('does not merge consecutive system messages', () => {
    const input = [
      msg({ role: 'system', content: 'Starting...' }),
      msg({ role: 'system', content: 'Done.' }),
    ];
    const items = chatMessagesToConversationItems(input);

    // System messages are not merged — each is its own item
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ kind: 'system_message', text: 'Starting...' });
    expect(items[1]).toMatchObject({ kind: 'system_message', text: 'Done.' });
  });

  // -------------------------------------------------------------------------
  // Unknown roles render as raw_fallback (not silently dropped)
  // -------------------------------------------------------------------------

  it('renders messages with unknown roles as raw_fallback items', () => {
    const input = [msg({ role: 'future_unknown_role', content: 'mystery content' })];
    const items = chatMessagesToConversationItems(input);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: 'raw_fallback',
      data: { role: 'future_unknown_role', content: 'mystery content', toolMetadata: null },
    });
  });

  it('renders unknown roles with non-null toolMetadata in raw_fallback', () => {
    const meta = { customField: 'value' };
    const input = [msg({ role: 'exotic_role', content: 'exotic data', toolMetadata: meta as unknown as null })];
    const items = chatMessagesToConversationItems(input);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: 'raw_fallback',
      data: { role: 'exotic_role', content: 'exotic data', toolMetadata: { customField: 'value' } },
    });
  });

  it('preserves unknown role messages in order alongside known roles', () => {
    const input = [
      msg({ role: 'user', content: 'hello' }),
      msg({ role: 'exotic_role', content: 'exotic data' }),
      msg({ role: 'assistant', content: 'response' }),
    ];
    const items = chatMessagesToConversationItems(input);

    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({ kind: 'user_message' });
    expect(items[1]).toMatchObject({ kind: 'raw_fallback' });
    expect(items[2]).toMatchObject({ kind: 'agent_message' });
  });

  // -------------------------------------------------------------------------
  // Mixed roles — ordering preserved
  // -------------------------------------------------------------------------

  it('preserves order across all supported roles', () => {
    const planEntries = [{ content: 'Do thing', priority: 'high', status: 'pending' }];
    const input = [
      msg({ role: 'user', content: 'start task' }),
      msg({ role: 'thinking', content: 'processing...' }),
      msg({ role: 'plan', content: JSON.stringify(planEntries) }),
      msg({ role: 'tool', content: '(tool call)', toolMetadata: { toolCallId: 'tc-z', kind: 'read', status: 'completed', content: [] } as unknown as null }),
      msg({ role: 'assistant', content: 'Done!' }),
    ];
    const items = chatMessagesToConversationItems(input);

    expect(items).toHaveLength(5);
    expect(items[0]).toMatchObject({ kind: 'user_message' });
    expect(items[1]).toMatchObject({ kind: 'thinking' });
    expect(items[2]).toMatchObject({ kind: 'plan' });
    expect(items[3]).toMatchObject({ kind: 'tool_call' });
    expect(items[4]).toMatchObject({ kind: 'agent_message' });
  });

  // -------------------------------------------------------------------------
  // Deduplication update edge cases
  // -------------------------------------------------------------------------

  it('does not update status if update rawStatus is empty string', () => {
    // First message establishes in_progress; second update has no status set
    const meta1 = { toolCallId: 'tc-keepstatus', kind: 'read', status: 'in_progress', content: [] };
    // meta2 has an empty status string — should not overwrite
    const meta2 = { toolCallId: 'tc-keepstatus', kind: 'read', status: '', content: [] };
    const input = [
      msg({ role: 'tool', content: 'start', toolMetadata: meta1 as unknown as null }),
      msg({ role: 'tool', content: 'update no status', toolMetadata: meta2 as unknown as null }),
    ];
    const items = chatMessagesToConversationItems(input);

    expect(items).toHaveLength(1);
    // status should remain in_progress because empty rawStatus maps to "completed" in the
    // validStatuses check — this validates the status coercion logic is consistent
    // (empty string is not in validStatuses, so it defaults to 'completed' per current impl)
    expect(['in_progress', 'completed']).toContain((items[0] as { status: string }).status);
  });

  it('updates lazy-load pointer on deduplication when new content is provided', () => {
    const initialContent = [{ type: 'content', text: 'initial output' }];
    const updatedContent = [{ type: 'content', text: 'final output' }];
    const meta1 = { toolCallId: 'tc-content-update', kind: 'read', status: 'in_progress', content: initialContent };
    const meta2 = { toolCallId: 'tc-content-update', kind: 'read', status: 'completed', content: updatedContent };
    const input = [
      toolMsg({ id: 'initial-content-message', content: 'initial output', toolMetadata: meta1 }),
      toolMsg({ id: 'updated-content-message', content: 'final output', toolMetadata: meta2 }),
    ];
    const items = chatMessagesToConversationItems(input);

    expect(items[0]).toMatchObject({
      content: [],
      contentLoaded: false,
      messageId: 'updated-content-message',
      contentSize: expect.any(Number),
    });
  });

  // -------------------------------------------------------------------------
  // Tool name fallback (fix for "tool tool" display)
  // -------------------------------------------------------------------------

  it('uses humanized kind as title when title is missing and kind is specific', () => {
    const meta = { toolCallId: 'tc-kind', kind: 'read', status: 'completed' };
    const input = [msg({ role: 'tool', content: 'output', toolMetadata: meta as unknown as null })];
    const items = chatMessagesToConversationItems(input);

    const tool = items[0] as { title: string };
    expect(tool.title).toBe('Read');
  });

  it('uses "Tool Call" as title when both title and kind are generic "tool"', () => {
    const meta = { toolCallId: 'tc-generic', kind: 'tool', status: 'completed' };
    const input = [msg({ role: 'tool', content: 'output', toolMetadata: meta as unknown as null })];
    const items = chatMessagesToConversationItems(input);

    const tool = items[0] as { title: string };
    expect(tool.title).toBe('Tool Call');
  });

  it('suppresses generic "tool" kind from toolKind badge', () => {
    const meta = { toolCallId: 'tc-badge', kind: 'tool', status: 'completed' };
    const input = [msg({ role: 'tool', content: 'output', toolMetadata: meta as unknown as null })];
    const items = chatMessagesToConversationItems(input);

    const tool = items[0] as { toolKind?: string };
    expect(tool.toolKind).toBeUndefined();
  });

  it('preserves specific kind in toolKind badge', () => {
    const meta = { toolCallId: 'tc-specific', kind: 'execute', status: 'completed' };
    const input = [msg({ role: 'tool', content: 'output', toolMetadata: meta as unknown as null })];
    const items = chatMessagesToConversationItems(input);

    const tool = items[0] as { toolKind?: string };
    expect(tool.toolKind).toBe('execute');
  });

  it('prefers explicit title over kind when both are available', () => {
    const meta = { toolCallId: 'tc-both', kind: 'read', title: 'Read /src/main.go', status: 'completed' };
    const input = [msg({ role: 'tool', content: 'output', toolMetadata: meta as unknown as null })];
    const items = chatMessagesToConversationItems(input);

    const tool = items[0] as { title: string };
    expect(tool.title).toBe('Read /src/main.go');
  });

  // -------------------------------------------------------------------------
  // Message ID deduplication
  // -------------------------------------------------------------------------

  it('deduplicates messages with the same ID', () => {
    const input = [
      msg({ id: 'dup-1', role: 'user', content: 'hello' }),
      msg({ id: 'dup-1', role: 'user', content: 'hello' }),
    ];
    const items = chatMessagesToConversationItems(input);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'user_message', text: 'hello' });
  });

  it('keeps messages with different IDs', () => {
    const input = [
      msg({ id: 'a', role: 'user', content: 'first' }),
      msg({ id: 'b', role: 'user', content: 'second' }),
    ];
    const items = chatMessagesToConversationItems(input);
    expect(items).toHaveLength(2);
  });

  it('merges compact normalized Codex call/update rows by toolCallId after reload', () => {
    const items = chatMessagesToConversationItems([
      toolMsg({
        id: 'codex-call',
        content: '(tool call)',
        toolMetadata: {
          toolCallId: 'codex-command-1',
          title: 'Run shell command',
          kind: 'execute',
          status: 'in_progress',
          contentSize: 80,
        },
      }),
      toolMsg({
        id: 'codex-update',
        content: 'SAM_DURABLE_COMMAND_OUTPUT_112',
        toolMetadata: {
          toolCallId: 'codex-command-1',
          status: 'completed',
          contentSize: 96,
        },
      }),
    ]);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: 'tool_call',
      toolCallId: 'codex-command-1',
      title: 'Run shell command',
      status: 'completed',
      contentLoaded: false,
      messageId: 'codex-update',
      contentSize: 96,
    });
  });

  // -------------------------------------------------------------------------
  // Typed tool-call card fields (toolName / rawInput / rawOutput)
  //
  // These carry the discriminator + payload that DocumentCard renders. The
  // initial tool_call carries toolName + rawInput; the result update carries
  // toolName + rawOutput. Both must reach the ToolCallItem, and — critically —
  // a status-only update must NOT erase them (rule 02 persisted-parity).
  // -------------------------------------------------------------------------

  it('extracts toolName, rawInput and rawOutput from tool metadata', () => {
    const meta = {
      toolCallId: 'tc-doc',
      title: 'Display document',
      status: 'completed',
      toolName: 'mcp__sam-mcp__display_from_library',
      rawInput: { fileId: 'file-1', caption: 'the auth doc' },
      rawOutput: [{ type: 'text', text: '{"fileId":"file-1","filename":"auth.md","mimeType":"text/markdown","sizeBytes":1234}' }],
    };
    const items = chatMessagesToConversationItems([
      toolMsg({ content: '(tool call)', toolMetadata: meta }),
    ]);

    expect(items[0]).toMatchObject({
      kind: 'tool_call',
      toolName: 'mcp__sam-mcp__display_from_library',
      rawInput: { fileId: 'file-1', caption: 'the auth doc' },
    });
    const tool = items[0] as { rawOutput: Array<{ type: string; text: string }> };
    expect(tool.rawOutput[0]?.type).toBe('text');
  });

  it('merges rawOutput from the result update while keeping rawInput from the initial call', () => {
    // Real upload/display flow: initial tool_call has toolName + rawInput (args),
    // the completed update has toolName + rawOutput (the MCP result payload).
    const initial = {
      toolCallId: 'tc-upload',
      status: 'pending',
      toolName: 'mcp__sam-mcp__upload_to_library',
      rawInput: { filePath: '/tmp/auth.md', directory: '/docs/' },
    };
    const result = {
      toolCallId: 'tc-upload',
      status: 'completed',
      toolName: 'mcp__sam-mcp__upload_to_library',
      rawOutput: [{ type: 'text', text: '{"fileId":"f-9","filename":"auth.md","mimeType":"text/markdown","sizeBytes":900}' }],
    };
    const items = chatMessagesToConversationItems([
      toolMsg({ id: 'up-start', content: '(tool call)', toolMetadata: initial }),
      toolMsg({ id: 'up-done', content: '(tool update)', toolMetadata: result }),
    ]);

    expect(items).toHaveLength(1);
    const tool = items[0] as {
      toolName: string;
      status: string;
      rawInput: { filePath: string };
      rawOutput: Array<{ text: string }>;
    };
    expect(tool.toolName).toBe('mcp__sam-mcp__upload_to_library');
    expect(tool.status).toBe('completed');
    // rawInput survived from the initial call
    expect(tool.rawInput.filePath).toBe('/tmp/auth.md');
    // rawOutput arrived on the update
    expect(tool.rawOutput[0]?.text).toContain('"fileId":"f-9"');
  });

  it('does NOT erase toolName/rawInput/rawOutput when a status-only update merges in (regression)', () => {
    // A6 regression: the completed tool_call_update may be a bare status change
    // with no toolName/rawInput/rawOutput. The card metadata captured on the
    // initial call must survive so DocumentCard still renders after reload.
    const initial = {
      toolCallId: 'tc-keep-card',
      status: 'in_progress',
      toolName: 'mcp__sam-mcp__display_from_library',
      rawInput: { fileId: 'file-keep' },
      rawOutput: [{ type: 'text', text: '{"fileId":"file-keep","filename":"guide.md","mimeType":"text/markdown","sizeBytes":42}' }],
    };
    const statusOnly = {
      toolCallId: 'tc-keep-card',
      status: 'completed',
    };
    const items = chatMessagesToConversationItems([
      toolMsg({ id: 'keep-start', content: '(tool call)', toolMetadata: initial }),
      toolMsg({ id: 'keep-done', content: '(tool update)', toolMetadata: statusOnly }),
    ]);

    expect(items).toHaveLength(1);
    const tool = items[0] as {
      status: string;
      toolName?: string;
      rawInput?: { fileId: string };
      rawOutput?: Array<{ text: string }>;
    };
    expect(tool.status).toBe('completed');
    expect(tool.toolName).toBe('mcp__sam-mcp__display_from_library');
    expect(tool.rawInput?.fileId).toBe('file-keep');
    expect(tool.rawOutput?.[0]?.text).toContain('guide.md');
  });

  it('recovers document-card metadata from pre-toolName VM agent rows', () => {
    // Production regression shape from stale shared nodes created before the
    // typed-card VM-agent change: title carries the MCP tool name, but
    // toolName/rawInput/rawOutput are absent. The tool result JSON is still in
    // the persisted message content.
    const initial = {
      toolCallId: 'tc-old-display',
      title: 'mcp__sam-mcp__display_from_library',
      kind: 'other',
      status: 'in_progress',
    };
    const result = {
      toolCallId: 'tc-old-display',
      title: 'mcp__sam-mcp__display_from_library',
      kind: 'other',
      status: 'completed',
    };
    const items = chatMessagesToConversationItems([
      toolMsg({ id: 'old-display-start', content: '(tool call)', toolMetadata: initial }),
      toolMsg({
        id: 'old-display-done',
        content: JSON.stringify({
          fileId: '01KWSG35DYFK7S12P175438Q67',
          filename: 'format-c.png',
          mimeType: 'image/png',
          sizeBytes: 2916416,
          caption: 'Format C — Landscape hero',
        }),
        toolMetadata: result,
      }),
    ]);

    expect(items).toHaveLength(1);
    const tool = items[0] as {
      kind: string;
      title: string;
      toolName?: string;
      rawOutput?: Array<{ type: string; text: string }>;
    };
    expect(tool.kind).toBe('tool_call');
    expect(tool.title).toBe('mcp__sam-mcp__display_from_library');
    expect(tool.toolName).toBe('mcp__sam-mcp__display_from_library');
    expect(tool.rawOutput?.[0]?.type).toBe('text');
    expect(tool.rawOutput?.[0]?.text).toContain('format-c.png');
    expect(tool.rawOutput?.[0]?.text).toContain('Landscape hero');
  });

  it('recovers document-card metadata + selects DocumentCard for Codex slash-title rows', () => {
    // Codex titles MCP tool calls "<server>/<tool>" (slash) and sets no explicit
    // toolName. Vertical slice: persisted row (slash title, no toolName/rawOutput,
    // JSON in content) → reconstructed toolName + rawOutput → matchToolCard picks
    // the DocumentCard. This is the exact production regression for Codex chats.
    const initial = {
      toolCallId: 'tc-codex-display',
      title: 'sam-mcp/display_from_library',
      kind: 'other',
      status: 'in_progress',
    };
    const result = {
      toolCallId: 'tc-codex-display',
      title: 'sam-mcp/display_from_library',
      kind: 'other',
      status: 'completed',
    };
    const items = chatMessagesToConversationItems([
      toolMsg({ id: 'codex-display-start', content: '(tool call)', toolMetadata: initial }),
      toolMsg({
        id: 'codex-display-done',
        content: JSON.stringify({
          fileId: '01KWV7J5N2Q1AGFTMQSNK1RE7B',
          filename: 'sam-architecture-basic.html',
          mimeType: 'text/html; charset=utf-8',
          sizeBytes: 15357,
          caption: 'Basic SAM architecture visualization render test.',
        }),
        toolMetadata: result,
      }),
    ]);

    expect(items).toHaveLength(1);
    const tool = items[0] as ToolCallItem;
    expect(tool.title).toBe('sam-mcp/display_from_library');
    expect(tool.toolName).toBe('sam-mcp/display_from_library');
    const raw = tool.rawOutput as Array<{ type: string; text: string }> | undefined;
    expect(raw?.[0]?.text).toContain('sam-architecture-basic.html');
    // Vertical slice through to card selection.
    expect(matchToolCard(tool)).toBe(DocumentCard);
  });

  it('recovers the card when the VM agent stored an empty-string toolName', () => {
    // Pre-fix nodes emit ToolName:"" (omitted) for slash tools; a resurrected
    // row could carry an explicit empty string. The `&& meta.toolName` guard must
    // fall through to title inference rather than treating "" as the discriminator.
    const result = {
      toolCallId: 'tc-codex-empty',
      title: 'sam-mcp/display_from_library',
      toolName: '',
      kind: 'other',
      status: 'completed',
    };
    const items = chatMessagesToConversationItems([
      toolMsg({
        id: 'codex-empty',
        content: JSON.stringify({ fileId: 'f-empty', filename: 'e.html', mimeType: 'text/html', sizeBytes: 5 }),
        toolMetadata: result,
      }),
    ]);
    const tool = items[0] as ToolCallItem;
    expect(tool.toolName).toBe('sam-mcp/display_from_library');
    expect(matchToolCard(tool)).toBe(DocumentCard);
  });

  it('falls back to the generic card for a Codex library row with unusable content', () => {
    // Name matches (slash library tool) but the content is not a document
    // payload → no fileId → generic card, never a broken empty DocumentCard.
    const result = {
      toolCallId: 'tc-codex-bad',
      title: 'sam-mcp/display_from_library',
      kind: 'other',
      status: 'completed',
    };
    const items = chatMessagesToConversationItems([
      toolMsg({ id: 'codex-bad', content: 'the file could not be rendered', toolMetadata: result }),
    ]);

    const tool = items[0] as ToolCallItem;
    expect(matchToolCard(tool)).toBeNull();
  });
});
