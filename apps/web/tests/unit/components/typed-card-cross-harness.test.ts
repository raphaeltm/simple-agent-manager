/**
 * Typed chat cards must render for every agent harness, not only Claude Code.
 *
 * Production incident (2026-11-12, session b0c764d3-1270-44d2-a8fa-2510d4c10814): a Codex
 * `request_secret` call rendered as raw JSON inside a generic "2 tool calls" group instead of the
 * secure input card. Codex persists an MCP call as sparse rows (see
 * tasks/archive/2026-08-03-fix-sparse-codex-library-card-updates.md):
 *
 *   1. the initial call, titled `mcp.sam-mcp.<tool>`, with NO toolName (the VM agent only claims
 *      a title as toolName for library tools, `message_extract.go:extractToolName`) and no
 *      rawOutput;
 *   2. a status-only update;
 *   3. the completed update: toolCallId + status only, the tool's JSON result in `content`.
 *
 * Claude Code repeats `toolName` on every row and the API keeps the card payload as rawOutput,
 * so a Claude-only test cannot see this. Every case here enters the way the chat does: persisted
 * rows → chatMessagesToConversationItems → matchToolCard → groupToolCallItems.
 */
import type { ConversationItem, ToolCallItem } from '@simple-agent-manager/acp-client';
import { describe, expect, it } from 'vitest';

import { chatMessagesToConversationItems } from '../../../src/components/project-message-view';
import { groupToolCallItems } from '../../../src/components/project-message-view/tool-call-groups';
import { ApprovalCard } from '../../../src/components/project-message-view/tool-cards/ApprovalCard';
import { DocumentCard } from '../../../src/components/project-message-view/tool-cards/DocumentCard';
import { HumanInputCard } from '../../../src/components/project-message-view/tool-cards/HumanInputCard';
import { matchToolCard } from '../../../src/components/project-message-view/tool-cards/registry';
import { SecretRequestCard } from '../../../src/components/project-message-view/tool-cards/SecretRequestCard';
import { TYPED_CARD_TOOLS } from '../../../src/components/project-message-view/tool-cards/typed-card-tools';
import type { ChatMessageResponse } from '../../../src/lib/api';

let seq = 0;
function row(
  id: string,
  content: string,
  toolMetadata: Record<string, unknown>
): ChatMessageResponse {
  seq += 1;
  return {
    id,
    sessionId: 'sess-codex',
    role: 'tool',
    content,
    toolMetadata: toolMetadata as unknown as null,
    createdAt: 1_794_492_900_000 + seq,
  };
}

/** The successful `request_secret` result, shaped as `handleRequestSecret` returns it. */
const SECRET_RESULT = JSON.stringify({
  message:
    'Secret request recorded. A project owner or admin can supply SAM_CHAT_SECRET_TEST on the card in this chat. Then use exec_with_secrets with secretNames ["SAM_CHAT_SECRET_TEST"].',
  secretRequest: {
    id: '01M781STQK6N3SY47G641QTS2X',
    sessionId: 'sess-codex',
    name: 'SAM_CHAT_SECRET_TEST',
    status: 'pending',
    expiresAt: '2026-11-13T14:15:17.000Z',
    ttlSeconds: 600,
    replacesExisting: false,
    deduplicated: false,
    notificationSent: true,
  },
});

/** A generic tool call ahead of the card, as in the reported "2 tool calls" group. */
function genericCodexCall(callId: string): ChatMessageResponse[] {
  return [
    row(`${callId}-start`, '(tool call)', {
      toolCallId: callId,
      title: 'Run git status',
      kind: 'execute',
      status: 'in_progress',
    }),
    row(`${callId}-done`, 'On branch main\nnothing to commit', {
      toolCallId: callId,
      status: 'completed',
    }),
  ];
}

/** Codex's three sparse rows for one MCP call. */
function codexSparseCall(
  callId: string,
  tool: string,
  result: string,
  finalStatus: 'completed' | 'failed' | null = 'completed',
  extraInitial: Record<string, unknown> = {}
): ChatMessageResponse[] {
  const rows = [
    row(`${callId}-start`, '(tool call)', {
      toolCallId: callId,
      title: `mcp.sam-mcp.${tool}`,
      kind: 'execute',
      status: 'in_progress',
      ...extraInitial,
    }),
    row(`${callId}-progress`, '(tool update)', { toolCallId: callId, status: 'in_progress' }),
  ];
  if (finalStatus) {
    rows.push(row(`${callId}-done`, result, { toolCallId: callId, status: finalStatus }));
  }
  return rows;
}

function toolCalls(items: ConversationItem[]): ToolCallItem[] {
  return items.filter((item): item is ToolCallItem => item.kind === 'tool_call');
}

/** Ids of top-level tool calls that are NOT inside a generic group. */
function standaloneToolCallIds(items: ConversationItem[]): string[] {
  return groupToolCallItems(items)
    .filter((item): item is ToolCallItem => item.kind === 'tool_call')
    .map((item) => item.toolCallId);
}

function groupedToolCallIds(items: ConversationItem[]): string[] {
  return groupToolCallItems(items).flatMap((item) =>
    item.kind === 'tool_call_group'
      ? item.items.filter((i) => i.kind === 'tool_call').map((i) => (i as ToolCallItem).toolCallId)
      : []
  );
}

describe('Codex request_secret renders the secure card (production regression)', () => {
  it('renders SecretRequestCard outside the generic group for the exact Codex sparse sequence', () => {
    const items = chatMessagesToConversationItems([
      ...genericCodexCall('call_git'),
      ...codexSparseCall('call_secret', 'request_secret', SECRET_RESULT),
    ]);

    const [git, secret] = toolCalls(items);
    expect(secret).toMatchObject({
      toolCallId: 'call_secret',
      title: 'mcp.sam-mcp.request_secret',
      toolName: 'mcp.sam-mcp.request_secret',
      status: 'completed',
    });
    expect(matchToolCard(secret!)).toBe(SecretRequestCard);
    // The generic call is still grouped; the card breaks the run instead of joining it.
    expect(matchToolCard(git!)).toBeNull();
    expect(standaloneToolCallIds(items)).toEqual(['call_secret']);
    expect(groupedToolCallIds(items)).toEqual(['call_git']);
  });

  it('renders the card from a reloaded compact history (content-only result, no rawOutput)', () => {
    // Compact history strips `meta.content` and replaces it with `contentSize`; the row's own
    // `content` column still carries the result. A Codex result row names no tool, so the API's
    // compact path cannot keep a rawOutput for it; the web must recover it by toolCallId.
    const items = chatMessagesToConversationItems([
      row('s-start', '(tool call)', {
        toolCallId: 'call_reload',
        title: 'mcp.sam-mcp.request_secret',
        kind: 'execute',
        status: 'in_progress',
      }),
      row('s-done', SECRET_RESULT, {
        toolCallId: 'call_reload',
        status: 'completed',
        contentSize: SECRET_RESULT.length,
      }),
    ]);

    const [secret] = toolCalls(items);
    expect(secret?.rawOutput).toBeDefined();
    expect(matchToolCard(secret!)).toBe(SecretRequestCard);
    expect(standaloneToolCallIds(items)).toEqual(['call_reload']);
  });

  it('infers the tool from the title when the VM agent stored an empty-string toolName', () => {
    const items = chatMessagesToConversationItems(
      codexSparseCall('call_empty', 'request_secret', SECRET_RESULT, 'completed', { toolName: '' })
    );
    const [secret] = toolCalls(items);
    expect(secret?.toolName).toBe('mcp.sam-mcp.request_secret');
    expect(matchToolCard(secret!)).toBe(SecretRequestCard);
  });

  it('renders from a single title-only row carrying the result (slash naming)', () => {
    const items = chatMessagesToConversationItems([
      row('slash', SECRET_RESULT, {
        toolCallId: 'call_slash',
        title: 'sam-mcp/request_secret',
        kind: 'other',
        status: 'completed',
      }),
    ]);
    expect(matchToolCard(toolCalls(items)[0]!)).toBe(SecretRequestCard);
  });

  it('keeps a running call on the generic card until the result arrives', () => {
    const items = chatMessagesToConversationItems([
      ...genericCodexCall('call_git'),
      ...codexSparseCall('call_running', 'request_secret', '', null),
    ]);
    const secret = toolCalls(items)[1]!;
    expect(secret.status).toBe('in_progress');
    expect(matchToolCard(secret)).toBeNull();
    expect(groupedToolCallIds(items)).toEqual(['call_git', 'call_running']);
  });

  it('keeps a failed call on the generic card so its error stays visible', () => {
    const items = chatMessagesToConversationItems(
      codexSparseCall(
        'call_failed',
        'request_secret',
        'Error: name must be an uppercase environment variable name',
        'failed'
      )
    );
    const secret = toolCalls(items)[0]!;
    expect(secret.status).toBe('failed');
    expect(matchToolCard(secret)).toBeNull();
    expect(groupedToolCallIds(items)).toEqual(['call_failed']);
  });

  it('keeps a failed call generic even when its content is JSON carrying a request id', () => {
    const items = chatMessagesToConversationItems(
      codexSparseCall('call_failed_json', 'request_secret', SECRET_RESULT, 'failed')
    );
    const secret = toolCalls(items)[0]!;
    // Liveness: the payload WAS recovered, so the generic fallback is the status gate's choice.
    expect(secret.rawOutput).toBeDefined();
    expect(matchToolCard(secret)).toBeNull();
  });

  it('keeps a completed call with a malformed result on the generic card', () => {
    const items = chatMessagesToConversationItems([
      ...codexSparseCall('call_bad', 'request_secret', 'secret request could not be recorded'),
      ...codexSparseCall('call_no_id', 'request_secret', JSON.stringify({ secretRequest: {} })),
    ]);
    const [bad, noId] = toolCalls(items);
    expect(matchToolCard(bad!)).toBeNull();
    expect(matchToolCard(noId!)).toBeNull();
    expect(groupedToolCallIds(items)).toEqual(['call_bad', 'call_no_id']);
  });

  it('still renders the card for the Claude Code shape (toolName on every row)', () => {
    const items = chatMessagesToConversationItems([
      row('c-start', '(tool call)', {
        toolCallId: 'toolu_claude',
        title: 'mcp__sam-mcp__request_secret',
        toolName: 'mcp__sam-mcp__request_secret',
        kind: 'other',
        status: 'pending',
      }),
      row('c-done', '(tool update)', {
        toolCallId: 'toolu_claude',
        toolName: 'mcp__sam-mcp__request_secret',
        status: 'completed',
        // The compact payload the API keeps (`secretRequestPayload`).
        rawOutput: [
          { type: 'text', text: JSON.stringify({ secretRequest: { id: 'req-claude' } }) },
        ],
        contentSize: 400,
      }),
    ]);
    expect(matchToolCard(toolCalls(items)[0]!)).toBe(SecretRequestCard);
  });
});

/**
 * One valid result per typed-card tool. The key set must equal TYPED_CARD_TOOLS, so a new card
 * cannot ship without a cross-harness fixture here.
 */
const TYPED_CARD_FIXTURES: Record<string, { result: string; card: unknown }> = {
  upload_to_library: {
    result: JSON.stringify({
      fileId: 'f-1',
      filename: 'a.md',
      mimeType: 'text/markdown',
      sizeBytes: 10,
    }),
    card: DocumentCard,
  },
  replace_library_file: {
    result: JSON.stringify({
      fileId: 'f-2',
      filename: 'b.md',
      mimeType: 'text/markdown',
      sizeBytes: 20,
    }),
    card: DocumentCard,
  },
  display_from_library: {
    result: JSON.stringify({
      fileId: 'f-3',
      filename: 'c.html',
      mimeType: 'text/html',
      sizeBytes: 30,
    }),
    card: DocumentCard,
  },
  ops_request_action: {
    result: JSON.stringify({ message: 'Approval requested.', approval: { id: 'appr-1' } }),
    card: ApprovalCard,
  },
  request_human_input: {
    result: JSON.stringify({ humanInputRequest: { id: 'att-1', sessionId: 'sess-codex' } }),
    card: HumanInputCard,
  },
  request_secret: { result: SECRET_RESULT, card: SecretRequestCard },
};

describe('every typed card renders for the Codex sparse shape', () => {
  it('has a fixture for every typed-card tool', () => {
    expect(Object.keys(TYPED_CARD_FIXTURES).sort()).toEqual([...TYPED_CARD_TOOLS].sort());
  });

  for (const [tool, { result, card }] of Object.entries(TYPED_CARD_FIXTURES)) {
    it(`${tool}: renders its card outside the generic group`, () => {
      const items = chatMessagesToConversationItems([
        ...genericCodexCall('call_before'),
        ...codexSparseCall(`call_${tool}`, tool, result),
      ]);
      const typed = toolCalls(items)[1]!;
      expect(matchToolCard(typed)).toBe(card);
      expect(standaloneToolCallIds(items)).toEqual([`call_${tool}`]);
    });
  }
});
