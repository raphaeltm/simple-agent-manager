/**
 * `matchToolCard` sits on two hot paths for the same item object on every
 * streamed token (the grouping pass and the row renderer), and for a library
 * tool its payload branch `JSON.parse`s `rawOutput`. These tests pin that the
 * work happens once per item OBJECT — and, just as importantly, that a rebuilt
 * item object is re-evaluated, because `chatMessagesToConversationItems`
 * rebuilds every item on every token and a stale verdict would be worse than
 * the duplicate work.
 */
import type { ToolCallItem } from '@simple-agent-manager/acp-client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const extractSpy = vi.fn();

vi.mock(
  '../../../src/components/project-message-view/tool-cards/document-card-data',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('../../../src/components/project-message-view/tool-cards/document-card-data')
      >();
    return {
      ...actual,
      extractDocumentCardData: (item: ToolCallItem) => {
        extractSpy(item);
        return actual.extractDocumentCardData(item);
      },
    };
  }
);

const { matchToolCard } =
  await import('../../../src/components/project-message-view/tool-cards/registry');

function libraryCall(overrides: Partial<ToolCallItem> = {}): ToolCallItem {
  return {
    kind: 'tool_call',
    id: 'doc-1',
    toolCallId: 'tc-doc-1',
    title: 'display_from_library',
    toolName: 'mcp__sam-mcp__display_from_library',
    status: 'completed',
    content: [],
    locations: [],
    timestamp: 1_000,
    rawInput: { fileId: 'file-1' },
    ...overrides,
  };
}

describe('matchToolCard memoization', () => {
  beforeEach(() => {
    extractSpy.mockClear();
  });

  it('evaluates the payload once per item object', () => {
    const item = libraryCall();

    const first = matchToolCard(item);
    const second = matchToolCard(item);

    expect(first).not.toBeNull();
    expect(second).toBe(first);
    expect(extractSpy).toHaveBeenCalledTimes(1);
  });

  it('re-evaluates a rebuilt item object so a mutated payload cannot go stale', () => {
    matchToolCard(libraryCall());
    expect(extractSpy).toHaveBeenCalledTimes(1);

    // A fresh object with the SAME ids — what every streamed token produces.
    matchToolCard(libraryCall());
    expect(extractSpy).toHaveBeenCalledTimes(2);
  });

  it('caches the negative verdict too, without touching the payload branch', () => {
    const generic: ToolCallItem = {
      kind: 'tool_call',
      id: 't-1',
      toolCallId: 'tc-1',
      title: 'Bash: pnpm test',
      status: 'completed',
      content: [],
      locations: [],
      timestamp: 1_000,
    };

    expect(matchToolCard(generic)).toBeNull();
    expect(matchToolCard(generic)).toBeNull();
    // The name check rejects it before the payload is ever parsed.
    expect(extractSpy).not.toHaveBeenCalled();
  });
});
