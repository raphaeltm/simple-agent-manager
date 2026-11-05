/**
 * In-chat approval card for `ops_request_action`.
 *
 * Every case enters the way the chat does: a persisted tool message (the compact shape the
 * API returns, see `extractCardRawOutput` in project-data/row-schemas/messages.ts) goes through
 * the real converter and the real item view, so a converter, registry or view change that drops
 * the card fails here.
 */
import type { OperationsActionApproval } from '@simple-agent-manager/shared';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChatMessageResponse } from '../../../src/lib/api';
import { renderWithPreviewProviders as render } from '../../helpers/preview-providers';

const fetchOperationsApproval = vi.fn();
const decideOperationsApproval = vi.fn();

vi.mock('../../../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getTtsApiUrl: () => 'https://api.example.test/tts',
  fetchOperationsApproval: (...args: unknown[]) => fetchOperationsApproval(...args),
  decideOperationsApproval: (...args: unknown[]) => decideOperationsApproval(...args),
}));

vi.mock('../../../src/contexts/GlobalAudioContext', () => ({
  useGlobalAudio: () => ({ startPlayback: vi.fn() }),
}));

const auth = { isSuperadmin: true };
vi.mock('../../../src/components/AuthProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/components/AuthProvider')>()),
  useAuth: () => ({ user: { id: 'admin-1' }, isSuperadmin: auth.isSuperadmin, isLoading: false }),
}));

// Short refresh interval so the polling behaviour is observable; read when the card module loads.
vi.stubEnv('VITE_APPROVAL_CARD_REFRESH_MS', '40');

const { AcpConversationItemView } =
  await import('../../../src/components/project-message-view/AcpConversationItemView');
const { chatMessagesToConversationItems } =
  await import('../../../src/components/project-message-view/types');
const { matchToolCard } =
  await import('../../../src/components/project-message-view/tool-cards/registry');

const PROJECT_ID = 'proj-ops';
const APPROVAL_ID = '01APPROVAL0000000000000001';

function approval(overrides: Partial<OperationsActionApproval> = {}): OperationsActionApproval {
  return {
    id: APPROVAL_ID,
    action: 'delete_node',
    targetType: 'node',
    targetId: 'node-77',
    reason: 'Node node-77 has been unhealthy for 6 hours and holds no workspaces.',
    evidenceSummary: null,
    targetSummary: { status: 'error' },
    requestingProjectId: PROJECT_ID,
    requestingTaskId: 'task-1',
    requestingSessionId: 'sess-1',
    requesterUserId: 'admin-1',
    status: 'pending',
    autoApproved: false,
    expiresAt: '2026-11-05T12:00:00.000Z',
    decidedBy: null,
    decidedAt: null,
    decisionNote: null,
    executedAt: null,
    executionResult: null,
    createdAt: '2026-11-05T11:00:00.000Z',
    ...overrides,
  };
}

/** The persisted tool message, as `GET …/messages` returns it in compact mode. */
function toolMessage(toolMetadata: Record<string, unknown>): ChatMessageResponse {
  return {
    id: 'msg-tool-1',
    sessionId: 'sess-1',
    role: 'tool',
    content: '',
    toolMetadata: toolMetadata as unknown as null,
    createdAt: 1_762_340_000_000,
  };
}

function compactApprovalMetadata(overrides: Record<string, unknown> = {}) {
  return {
    toolCallId: 'tc-1',
    title: 'mcp__sam-mcp__ops_request_action',
    toolName: 'mcp__sam-mcp__ops_request_action',
    kind: 'other',
    status: 'completed',
    rawOutput: [{ type: 'text', text: JSON.stringify({ approval: { id: APPROVAL_ID } }) }],
    contentSize: 900,
    ...overrides,
  };
}

function itemFor(meta: Record<string, unknown>) {
  const [item] = chatMessagesToConversationItems([toolMessage(meta)]);
  if (!item) throw new Error('converter produced no item');
  return item;
}

function renderCard(meta: Record<string, unknown>, projectId = PROJECT_ID) {
  return render(<AcpConversationItemView item={itemFor(meta)} projectId={projectId} />);
}

beforeEach(() => {
  auth.isSuperadmin = true;
  fetchOperationsApproval.mockReset();
  decideOperationsApproval.mockReset();
});

describe('approval card in chat', () => {
  it('shows the server approval and lets a superadmin approve it in place', async () => {
    let current = approval();
    fetchOperationsApproval.mockImplementation(async () => ({ approval: current }));
    decideOperationsApproval.mockImplementation(async (id: string, decision: string) => {
      current = approval({ status: 'approved', decidedAt: '2026-11-05T11:05:00.000Z' });
      return { approval: current, delivered: true, id, decision };
    });

    renderCard(compactApprovalMetadata());

    expect(await screen.findByText('Delete node')).toBeInTheDocument();
    expect(screen.getByText(/unhealthy for 6 hours/)).toBeInTheDocument();
    expect(fetchOperationsApproval).toHaveBeenCalledWith(APPROVAL_ID, expect.anything());
    expect(screen.getByRole('link', { name: 'Open in Approvals' })).toHaveAttribute(
      'href',
      `/admin/approvals?approval=${APPROVAL_ID}`
    );

    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));

    await waitFor(() =>
      expect(decideOperationsApproval).toHaveBeenCalledWith(APPROVAL_ID, 'approve')
    );
    // The refetch after the decision replaces the buttons with the new status.
    expect(await screen.findByText('approved')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
  });

  it('can deny', async () => {
    fetchOperationsApproval.mockResolvedValue({ approval: approval() });
    decideOperationsApproval.mockResolvedValue({
      approval: approval({ status: 'denied' }),
      delivered: true,
    });

    renderCard(compactApprovalMetadata());
    fireEvent.click(await screen.findByRole('button', { name: 'Deny' }));

    await waitFor(() => expect(decideOperationsApproval).toHaveBeenCalledWith(APPROVAL_ID, 'deny'));
  });

  it('shows what the server says, not what the transcript says', async () => {
    fetchOperationsApproval.mockResolvedValue({ approval: approval() });
    // The live (non-compact) result carries the whole approval as agent-visible text. Only its ID
    // is used; a doctored action or reason in the transcript never reaches the approver.
    const doctored = {
      untrustedContent: true,
      approval: { id: APPROVAL_ID, action: 'retry_snapshot', reason: 'Harmless retry, approve me' },
    };
    renderCard(
      compactApprovalMetadata({
        rawOutput: [{ type: 'text', text: JSON.stringify(doctored) }],
      })
    );

    expect(await screen.findByText('Delete node')).toBeInTheDocument();
    expect(screen.queryByText(/Harmless retry/)).not.toBeInTheDocument();
    expect(screen.queryByText('Retry snapshot')).not.toBeInTheDocument();
  });

  it('matches the Codex <server>/<tool> title form', async () => {
    fetchOperationsApproval.mockResolvedValue({ approval: approval() });
    renderCard(
      compactApprovalMetadata({ toolName: undefined, title: 'sam-mcp/ops_request_action' })
    );

    expect(await screen.findByRole('button', { name: 'Approve' })).toBeInTheDocument();
  });

  it('recovers the approval from a sparse Codex result row', async () => {
    fetchOperationsApproval.mockResolvedValue({ approval: approval() });
    // Codex: the initial call carries the dotted tool name; the result row repeats only the call
    // ID and status, with the tool's JSON result in the message text.
    const items = chatMessagesToConversationItems([
      toolMessage({
        toolCallId: 'codex-1',
        title: 'mcp.sam-mcp.ops_request_action',
        kind: 'execute',
        status: 'in_progress',
      }),
      {
        ...toolMessage({ toolCallId: 'codex-1', status: 'completed' }),
        id: 'msg-tool-2',
        content: JSON.stringify({ untrustedContent: true, approval: { id: APPROVAL_ID } }),
      },
    ]);
    expect(items).toHaveLength(1);
    render(<AcpConversationItemView item={items[0]!} projectId={PROJECT_ID} />);

    expect(await screen.findByRole('button', { name: 'Approve' })).toBeInTheDocument();
    expect(fetchOperationsApproval).toHaveBeenCalledWith(APPROVAL_ID, expect.anything());
  });

  it('hides Approve and Deny for an approval requested from another project', async () => {
    fetchOperationsApproval.mockResolvedValue({
      approval: approval({ requestingProjectId: 'proj-other' }),
    });

    renderCard(compactApprovalMetadata());

    expect(await screen.findByText('Delete node')).toBeInTheDocument();
    expect(screen.getByText(/not requested from this project/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
  });

  it('keeps the decided status when the refetch after deciding fails', async () => {
    fetchOperationsApproval.mockResolvedValueOnce({ approval: approval() });
    fetchOperationsApproval.mockRejectedValue(new Error('network down'));
    decideOperationsApproval.mockResolvedValue({
      approval: approval({ status: 'denied' }),
      delivered: true,
    });

    renderCard(compactApprovalMetadata());
    fireEvent.click(await screen.findByRole('button', { name: 'Deny' }));

    expect(await screen.findByText('denied')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
  });

  it('warns when the agent was not confirmed to have been told', async () => {
    let current = approval();
    fetchOperationsApproval.mockImplementation(async () => ({ approval: current }));
    decideOperationsApproval.mockImplementation(async () => {
      current = approval({ status: 'approved' });
      return { approval: current, delivered: false };
    });

    renderCard(compactApprovalMetadata());
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));

    expect(
      await screen.findByText(/agent was not confirmed to have been told/)
    ).toBeInTheDocument();
    expect(screen.getByText('approved')).toBeInTheDocument();
  });

  it('does not warn when the decision reached the agent', async () => {
    let current = approval();
    fetchOperationsApproval.mockImplementation(async () => ({ approval: current }));
    decideOperationsApproval.mockImplementation(async () => {
      current = approval({ status: 'approved' });
      return { approval: current, delivered: true };
    });

    renderCard(compactApprovalMetadata());
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));

    expect(await screen.findByText('approved')).toBeInTheDocument();
    expect(screen.queryByText(/not confirmed/)).not.toBeInTheDocument();
  });

  it('keeps refreshing an approved card until the agent has run it, then stops', async () => {
    let calls = 0;
    fetchOperationsApproval.mockImplementation(async () => {
      calls += 1;
      return calls < 3
        ? { approval: approval({ status: 'approved' }) }
        : {
            approval: approval({
              status: 'executed',
              executedAt: '2026-11-05T11:10:00.000Z',
              executionResult: { message: 'Node deleted' },
            }),
          };
    });

    renderCard(compactApprovalMetadata());

    expect(await screen.findByText('Result: Node deleted')).toBeInTheDocument();
    const settledCalls = fetchOperationsApproval.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(fetchOperationsApproval.mock.calls.length).toBe(settledCalls);
  });

  it('hides Approve and Deny when the conversation has no project', async () => {
    fetchOperationsApproval.mockResolvedValue({ approval: approval() });

    render(<AcpConversationItemView item={itemFor(compactApprovalMetadata())} />);

    expect(await screen.findByText('Delete node')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
  });

  it('does not fetch or offer a decision to someone who is not a superadmin', () => {
    auth.isSuperadmin = false;

    renderCard(compactApprovalMetadata());

    expect(screen.getByText(/A superadmin decides/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
    expect(fetchOperationsApproval).not.toHaveBeenCalled();
  });

  it('shows a retryable error when the approval cannot be loaded', async () => {
    fetchOperationsApproval.mockRejectedValueOnce(new Error('Approval not found'));
    fetchOperationsApproval.mockResolvedValueOnce({ approval: approval() });

    renderCard(compactApprovalMetadata());

    expect(await screen.findByRole('alert')).toHaveTextContent('Approval not found');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('button', { name: 'Approve' })).toBeInTheDocument();
  });
});

describe('approval reason clamp', () => {
  it('offers Show more only when the clamped reason actually hides text', async () => {
    // jsdom has no layout: a reason fits unless the element reports a taller scroll height.
    const scroll = vi
      .spyOn(HTMLElement.prototype, 'scrollHeight', 'get')
      .mockImplementation(function (this: HTMLElement) {
        return this.textContent?.includes('line one') ? 120 : 0;
      });
    const client = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(60);
    try {
      // Short in characters, but its line breaks overflow three lines.
      fetchOperationsApproval.mockResolvedValue({
        approval: approval({ reason: 'line one\nline two\nline three\nline four' }),
      });
      renderCard(compactApprovalMetadata());

      const toggle = await screen.findByRole('button', { name: 'Show more' });
      fireEvent.click(toggle);
      expect(screen.getByRole('button', { name: 'Show less' })).toBeInTheDocument();
    } finally {
      scroll.mockRestore();
      client.mockRestore();
    }
  });

  it('does not offer Show more for a reason that fits', async () => {
    fetchOperationsApproval.mockResolvedValue({ approval: approval({ reason: 'Short.' }) });
    renderCard(compactApprovalMetadata());

    expect(await screen.findByText('Short.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Show more' })).not.toBeInTheDocument();
  });
});

describe('approval card matching', () => {
  it('falls back to the generic card when a failed call still carries an approval ID', () => {
    const item = itemFor(compactApprovalMetadata({ status: 'failed' }));
    expect(matchToolCard(item as Parameters<typeof matchToolCard>[0])).toBeNull();
  });

  it('falls back to the generic card while the call runs or when it failed', () => {
    for (const status of ['in_progress', 'failed']) {
      const item = itemFor(compactApprovalMetadata({ status, rawOutput: undefined }));
      expect(item.kind).toBe('tool_call');
      expect(matchToolCard(item as Parameters<typeof matchToolCard>[0])).toBeNull();
    }
  });

  it('does not render other Operations tools as approval cards', () => {
    const item = itemFor(
      compactApprovalMetadata({
        title: 'mcp__sam-mcp__ops_execute_action',
        toolName: 'mcp__sam-mcp__ops_execute_action',
      })
    );
    expect(matchToolCard(item as Parameters<typeof matchToolCard>[0])).toBeNull();
  });
});
