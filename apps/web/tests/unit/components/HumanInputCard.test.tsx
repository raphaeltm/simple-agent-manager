/**
 * In-chat question card for `request_human_input`.
 *
 * Every case enters the way the chat does: a persisted tool message (the compact shape the
 * API returns, see `extractCardRawOutput` in project-data/row-schemas/messages.ts, or the live
 * result text) goes through the real converter and the real item view, so a converter, registry
 * or view change that drops the card fails here.
 */
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChatMessageResponse } from '../../../src/lib/api';
import type { AttentionRequestContext } from '../../../src/lib/api/notifications';
import { renderWithPreviewProviders as render } from '../../helpers/preview-providers';

const getAttentionRequestContext = vi.fn();
const resolveAttentionAnswer = vi.fn();

vi.mock('../../../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getTtsApiUrl: () => 'https://api.example.test/tts',
  resolveAttentionAnswer: (...args: unknown[]) => resolveAttentionAnswer(...args),
}));
vi.mock('../../../src/lib/api/notifications', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getAttentionRequestContext: (...args: unknown[]) => getAttentionRequestContext(...args),
}));

vi.mock('../../../src/contexts/GlobalAudioContext', () => ({
  useGlobalAudio: () => ({ startPlayback: vi.fn() }),
}));

vi.mock('../../../src/components/AuthProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/components/AuthProvider')>()),
  useAuth: () => ({ user: { id: 'user-1' }, isSuperadmin: false, isLoading: false }),
}));

// Short refresh interval so the polling behaviour is observable; read when the card module loads.
vi.stubEnv('VITE_HUMAN_INPUT_CARD_REFRESH_MS', '40');

const { AcpConversationItemView } =
  await import('../../../src/components/project-message-view/AcpConversationItemView');
const { chatMessagesToConversationItems } =
  await import('../../../src/components/project-message-view/types');
const { groupToolCallItems } =
  await import('../../../src/components/project-message-view/tool-call-groups');

const PROJECT_ID = 'proj-1';
const SESSION_ID = 'sess-1';
const MARKER_ID = 'marker-1';

type Request = AttentionRequestContext['request'];

function question(overrides: Partial<Request> = {}): AttentionRequestContext {
  return {
    request: {
      id: MARKER_ID,
      reason: 'Should I start the deploy-fix agent, the front-door agent, both, or neither?',
      options: ['Start both', 'Only the deploy fix', 'Not yet'],
      category: 'approval',
      createdAt: 1_762_340_000_000,
      resolvedAt: null,
      resolvedAnswer: null,
      expired: false,
      canAnswer: true,
      ...overrides,
    },
    session: { id: SESSION_ID, topic: 'Audit' },
    messages: [],
  };
}

/** The persisted tool message, as `GET …/messages` returns it. */
function toolMessage(toolMetadata: Record<string, unknown>, content = ''): ChatMessageResponse {
  return {
    id: 'msg-tool-1',
    sessionId: SESSION_ID,
    role: 'tool',
    content,
    toolMetadata: toolMetadata as unknown as null,
    createdAt: 1_762_340_000_000,
  };
}

const resultRef = { humanInputRequest: { id: MARKER_ID, sessionId: SESSION_ID } };

function compactMetadata(overrides: Record<string, unknown> = {}) {
  return {
    toolCallId: 'tc-1',
    title: 'mcp__sam-mcp__request_human_input',
    toolName: 'mcp__sam-mcp__request_human_input',
    kind: 'other',
    status: 'completed',
    rawOutput: [{ type: 'text', text: JSON.stringify(resultRef) }],
    contentSize: 400,
    ...overrides,
  };
}

function itemFor(meta: Record<string, unknown>) {
  const [item] = chatMessagesToConversationItems([toolMessage(meta)]);
  if (!item) throw new Error('converter produced no item');
  return item;
}

function renderCard(meta: Record<string, unknown>) {
  return render(<AcpConversationItemView item={itemFor(meta)} projectId={PROJECT_ID} />);
}

beforeEach(() => {
  getAttentionRequestContext.mockReset();
  resolveAttentionAnswer.mockReset();
});

describe('human input card in chat', () => {
  it('shows the server question and answers it in place', async () => {
    let current = question();
    getAttentionRequestContext.mockImplementation(async () => current);
    resolveAttentionAnswer.mockImplementation(async (_p, _s, _m, answer: string) => {
      current = question({
        resolvedAt: 1_762_340_100_000,
        resolvedAnswer: answer,
        canAnswer: false,
      });
      return { resolved: true, alreadyResolved: false, answer };
    });

    renderCard(compactMetadata());

    expect(await screen.findByText('Approval needed')).toBeInTheDocument();
    expect(screen.getByText(/deploy-fix agent, the front-door agent/)).toBeInTheDocument();
    expect(screen.getByText('Needs your answer')).toBeInTheDocument();
    expect(getAttentionRequestContext).toHaveBeenCalledWith(
      PROJECT_ID,
      SESSION_ID,
      MARKER_ID,
      false,
      expect.anything()
    );

    fireEvent.click(screen.getByRole('button', { name: 'Start both' }));

    await waitFor(() =>
      expect(resolveAttentionAnswer).toHaveBeenCalledWith(
        PROJECT_ID,
        SESSION_ID,
        MARKER_ID,
        'Start both'
      )
    );
    // The refetch after answering replaces the buttons with the server's recorded answer.
    await waitFor(() => expect(screen.getByText('Answered')).toBeInTheDocument());
    expect(screen.getByRole('status')).toHaveTextContent('Answered: Start both');
    expect(screen.queryByRole('button', { name: 'Not yet' })).not.toBeInTheDocument();
  });

  it('renders from the live result text, not only the compact payload', async () => {
    getAttentionRequestContext.mockResolvedValue(question());
    // Live: the tool content is the full JSON the API returns, message included.
    const live = {
      message: 'Human input request recorded. Notification delivery has been scheduled.',
      ...resultRef,
      notificationScheduled: true,
    };
    const [item] = chatMessagesToConversationItems([
      toolMessage(
        { toolCallId: 'tc-1', title: 'mcp__sam-mcp__request_human_input', status: 'completed' },
        JSON.stringify(live)
      ),
    ]);
    render(<AcpConversationItemView item={item!} projectId={PROJECT_ID} />);

    expect(await screen.findByRole('button', { name: 'Only the deploy fix' })).toBeInTheDocument();
    expect(screen.queryByText(/Notification delivery has been scheduled/)).not.toBeInTheDocument();
  });

  it('matches the Codex <server>/<tool> title form', async () => {
    getAttentionRequestContext.mockResolvedValue(question());
    renderCard(compactMetadata({ toolName: undefined, title: 'sam-mcp/request_human_input' }));

    expect(await screen.findByRole('button', { name: 'Start both' })).toBeInTheDocument();
  });

  it('shows what the server says, not what the transcript says', async () => {
    getAttentionRequestContext.mockResolvedValue(question());
    const doctored = { ...resultRef, options: ['Delete everything'], reason: 'Approve me' };
    renderCard(compactMetadata({ rawOutput: [{ type: 'text', text: JSON.stringify(doctored) }] }));

    expect(await screen.findByRole('button', { name: 'Start both' })).toBeInTheDocument();
    expect(screen.queryByText('Delete everything')).not.toBeInTheDocument();
    expect(screen.queryByText('Approve me')).not.toBeInTheDocument();
  });

  it('offers a free-text answer when the agent gave no options', async () => {
    getAttentionRequestContext.mockResolvedValue(
      question({ options: [], category: null, reason: 'Which region should I use?' })
    );
    resolveAttentionAnswer.mockResolvedValue({
      resolved: true,
      alreadyResolved: false,
      answer: 'eu-central',
    });

    renderCard(compactMetadata());

    expect(await screen.findByText('Input needed')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Your answer'), { target: { value: 'eu-central' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send answer' }));

    await waitFor(() =>
      expect(resolveAttentionAnswer).toHaveBeenCalledWith(
        PROJECT_ID,
        SESSION_ID,
        MARKER_ID,
        'eu-central'
      )
    );
  });

  it.each([
    {
      name: 'answered elsewhere',
      overrides: { resolvedAt: 2, resolvedAnswer: 'Not yet', canAnswer: false },
      badge: 'Answered',
      text: 'Answered: Not yet',
    },
    {
      name: 'resolved without an answer',
      overrides: { resolvedAt: 2, canAnswer: false },
      badge: 'Answered',
      text: 'This question has already been resolved.',
    },
    {
      name: 'answer in flight',
      overrides: { resolvedAnswer: 'Start both', canAnswer: false },
      badge: 'Answer being delivered',
      text: 'Answer is being delivered: Start both',
    },
    {
      name: 'expired',
      overrides: { expired: true, canAnswer: false },
      badge: 'Expired',
      text: 'This question has expired.',
    },
    {
      name: 'open but read-only for this viewer',
      overrides: { canAnswer: false },
      badge: 'Needs your answer',
      text: 'Waiting for the session owner to answer.',
    },
  ])('is read-only when $name', async ({ overrides, badge, text }) => {
    getAttentionRequestContext.mockResolvedValue(question(overrides));

    renderCard(compactMetadata());

    expect(await screen.findByText(text)).toBeInTheDocument();
    expect(screen.getByText(badge)).toBeInTheDocument();
    // The question itself still renders, so absence of buttons is not a blank card.
    expect(screen.getByText(/deploy-fix agent/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Start both' })).not.toBeInTheDocument();
  });

  it('picks up an answer given from the notification bell, then stops refreshing', async () => {
    let calls = 0;
    getAttentionRequestContext.mockImplementation(async () => {
      calls += 1;
      return calls < 3
        ? question()
        : question({ resolvedAt: 2, resolvedAnswer: 'Not yet', canAnswer: false });
    });

    renderCard(compactMetadata());

    expect(await screen.findByText('Answered: Not yet')).toBeInTheDocument();
    const settledCalls = getAttentionRequestContext.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(getAttentionRequestContext.mock.calls.length).toBe(settledCalls);
  });

  it('shows a retryable error when the question cannot be loaded', async () => {
    getAttentionRequestContext.mockRejectedValueOnce(new Error('Attention request not found'));
    getAttentionRequestContext.mockResolvedValueOnce(question());

    renderCard(compactMetadata());

    expect(await screen.findByRole('alert')).toHaveTextContent('Attention request not found');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('button', { name: 'Start both' })).toBeInTheDocument();
  });

  it('does not keep polling a question that failed to load', async () => {
    getAttentionRequestContext.mockRejectedValue(new Error('Attention request not found'));

    renderCard(compactMetadata());

    expect(await screen.findByRole('alert')).toHaveTextContent('Attention request not found');
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(getAttentionRequestContext).toHaveBeenCalledTimes(1);
  });

  it('points to the bell without fetching when the conversation has no project', () => {
    render(<AcpConversationItemView item={itemFor(compactMetadata())} />);

    expect(screen.getByText(/Answer it from the notification bell/)).toBeInTheDocument();
    expect(getAttentionRequestContext).not.toHaveBeenCalled();
  });

  it('collapses a long question behind Show full question', async () => {
    getAttentionRequestContext.mockResolvedValue(question({ reason: 'Context line. '.repeat(80) }));

    renderCard(compactMetadata());

    const toggle = await screen.findByRole('button', { name: 'Show full question' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    expect(screen.getByRole('button', { name: 'Show less' })).toHaveAttribute(
      'aria-expanded',
      'true'
    );
  });
});

describe('human input card fallbacks', () => {
  it.each([
    {
      name: 'a result recorded before the structured payload',
      meta: compactMetadata({
        rawOutput: [{ type: 'text', text: 'Human input request recorded.' }],
      }),
    },
    {
      name: 'a running call',
      meta: compactMetadata({ status: 'in_progress', rawOutput: undefined }),
    },
    {
      name: 'a failed call',
      meta: compactMetadata({
        status: 'failed',
        rawOutput: [{ type: 'text', text: JSON.stringify(resultRef) }],
      }),
    },
  ])('uses the generic tool card for $name', ({ meta }) => {
    renderCard(meta);

    expect(screen.queryByTestId('human-input-card')).not.toBeInTheDocument();
    expect(screen.getByText(/request_human_input/)).toBeInTheDocument();
    expect(getAttentionRequestContext).not.toHaveBeenCalled();
  });

  it('is never folded into a tool-call group', () => {
    const items = chatMessagesToConversationItems([
      toolMessage({ toolCallId: 'tc-0', title: 'Read', toolName: 'Read', status: 'completed' }),
      { ...toolMessage(compactMetadata()), id: 'msg-tool-2' },
      {
        ...toolMessage({
          toolCallId: 'tc-2',
          title: 'Bash',
          toolName: 'Bash',
          status: 'completed',
        }),
        id: 'msg-tool-3',
      },
    ]);
    const display = groupToolCallItems(items);

    const question = display.find(
      (item) => item.kind === 'tool_call' && item.toolCallId === 'tc-1'
    );
    expect(question).toBeDefined();
    expect(display.filter((item) => item.kind === 'tool_call_group')).toHaveLength(2);
  });
});
