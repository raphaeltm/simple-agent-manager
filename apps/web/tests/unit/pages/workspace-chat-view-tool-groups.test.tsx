/**
 * C6: the workspace chat surface must group tool calls exactly like project
 * chat, with the SAME parent-held expansion and the SAME live signal — not an
 * uncontrolled copy that flickers and forgets its expansion on scroll
 * (`.claude/rules/24`).
 *
 * Entered through the real `getChatSession` payload (rule 62), so the whole
 * conversion → grouping → row-render path runs.
 */
import { act, render, screen, waitFor } from '@testing-library/react';
import type { ReactElement, ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getChatSession: vi.fn(),
  getChatSessionState: vi.fn(),
  getTranscribeApiUrl: vi.fn(() => 'https://api.test/api/transcribe'),
  getTtsApiUrl: vi.fn(() => 'https://api.test/api/tts'),
  resetIdleTimer: vi.fn(),
  sendFollowUpPrompt: vi.fn(),
  uploadSessionFiles: vi.fn(),
  cancelAgentPrompt: vi.fn(),
}));

vi.mock('../../../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/api')>()),
  getChatSession: mocks.getChatSession,
  getChatSessionState: mocks.getChatSessionState,
  getTranscribeApiUrl: mocks.getTranscribeApiUrl,
  getTtsApiUrl: mocks.getTtsApiUrl,
  resetIdleTimer: mocks.resetIdleTimer,
  sendFollowUpPrompt: mocks.sendFollowUpPrompt,
  uploadSessionFiles: mocks.uploadSessionFiles,
  cancelAgentPrompt: mocks.cancelAgentPrompt,
}));

/** Captured so a test can push a row the way the DO socket does. */
let capturedWsOnMessage: ((msg: unknown) => void) | null = null;

vi.mock('../../../src/hooks/useChatWebSocket', () => ({
  useChatWebSocket: (opts: { onMessage?: (msg: unknown) => void }) => {
    capturedWsOnMessage = opts.onMessage ?? null;
    return { connectionState: 'connected', wsRef: { current: null }, retry: vi.fn() };
  },
}));

vi.mock('../../../src/contexts/GlobalAudioContext', () => ({
  useGlobalAudio: () => ({ startPlayback: vi.fn() }),
}));

vi.mock('react-virtuoso', async () => {
  const { createVirtuosoModuleMock } = await import('../../helpers/virtuoso-mock');
  return createVirtuosoModuleMock();
});

const virtuosoMock = {
  lastProps: (await import('../../helpers/virtuoso-mock')).virtuosoLastProps,
  reset: (await import('../../helpers/virtuoso-mock')).resetVirtuosoMock,
};

// The generic tool card is stubbed to its title so "hidden while collapsed" is
// unambiguous; the real card is exercised in ToolCallGroupCard.test.tsx.
vi.mock('@simple-agent-manager/acp-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@simple-agent-manager/acp-client')>();
  return {
    ...actual,
    MessageBubble: ({ text, role }: { text: string; role: string }) => (
      <div data-testid={`acp-message-${role}`}>{text}</div>
    ),
    ToolCallCard: ({ toolCall }: { toolCall: { title: string } }) => (
      <div data-testid="acp-tool-call">{toolCall.title}</div>
    ),
  };
});

const { WorkspaceChatView } = await import('../../../src/pages/workspace/WorkspaceChatView');
const { VIRTUAL_START } = await import('../../../src/components/project-message-view/types');

const SESSION_ID = 'ws-session-1';

function toolMessage(id: string, title: string, createdAt: number, status = 'completed') {
  return {
    id,
    sessionId: SESSION_ID,
    role: 'tool' as const,
    content: '(tool call)',
    toolMetadata: { toolCallId: `tc-${id}`, title, kind: 'execute', status, contentSize: 64 },
    createdAt,
  };
}

function textMessage(id: string, role: 'user' | 'assistant', content: string, createdAt: number) {
  return { id, sessionId: SESSION_ID, role, content, toolMetadata: null, createdAt };
}

function renderView(ui: ReactElement) {
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <MemoryRouter>{children}</MemoryRouter>
  );
  return render(ui, { wrapper: Wrapper });
}

describe('WorkspaceChatView — tool activity cards', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    virtuosoMock.reset();
    capturedWsOnMessage = null;
    mocks.getChatSessionState.mockResolvedValue({
      state: null,
      agentSessionId: null,
      agentType: null,
    });
    mocks.getChatSession.mockResolvedValue({
      session: {
        id: SESSION_ID,
        workspaceId: 'ws-1',
        topic: 'Workspace chat',
        status: 'active',
        messageCount: 5,
        createdAt: 1_000,
        endedAt: null,
      },
      messages: [
        textMessage('m-user', 'user', 'Run the checks please.', 1_000),
        toolMessage('m-t1', 'Bash: pnpm lint', 2_000),
        toolMessage('m-t2', 'Bash: pnpm typecheck', 3_000),
        toolMessage('m-t3', 'Bash: pnpm test', 4_000),
      ],
      hasMore: false,
    });
  });

  it('collapses a run of tool calls into one card', async () => {
    renderView(<WorkspaceChatView projectId="proj-1" sessionId={SESSION_ID} />);

    const header = await screen.findByRole('button', { name: /3 tool calls/ });
    expect(header).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryAllByTestId('acp-tool-call')).toHaveLength(0);
  });

  /*
   * A row arriving over the DO socket must join the EXISTING tail group rather
   * than start a second card — the live-tail case, driven through this view's
   * real `onMessage` handler.
   */
  it('absorbs a tool row that streams in over the socket into the tail group', async () => {
    renderView(<WorkspaceChatView projectId="proj-1" sessionId={SESSION_ID} />);

    await screen.findByRole('button', { name: /3 tool calls/ });

    await act(async () => {
      capturedWsOnMessage!(toolMessage('m-t4', 'Bash: pnpm build', 5_000));
    });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /4 tool calls/ })).toBeTruthy();
    });
    // Still ONE card, not a second one appended after it.
    expect(screen.getAllByTestId('tool-call-group')).toHaveLength(1);
  });

  /*
   * F5b on this surface, made DISCRIMINATING — and now through the shape that
   * actually dominates a long turn: a TOOL-ONLY burst.
   *
   * This is discriminating in two directions at once, because the pushed row is
   * a tool row whose call is already `completed`:
   *
   * - if `onMessage`'s role check goes back to `role === 'assistant'`, activity
   *   never leaves `idle` and the glyph stays settled;
   * - if `groupLive` goes back to `isWorkingActivity`, `responding` is not
   *   covered and the glyph stays settled.
   *
   * Nothing in the group's own statuses can produce the running glyph, so only
   * the `live` prop can — and the idle assertion first is the control that the
   * card is not simply always in motion.
   */
  it('lights the TAIL group from a tool-only burst', async () => {
    renderView(<WorkspaceChatView projectId="proj-1" sessionId={SESSION_ID} />);

    // Control: agent idle, every call settled -> the one glyph reads done.
    const glyph = await waitFor(() => screen.getByTestId('tool-group-glyph'));
    expect(glyph).toHaveAttribute('data-state', 'done');
    expect(screen.queryByText('· working')).toBeNull();

    // The real trigger: one more tool row over the socket. No assistant text at
    // any point, which is exactly the case that used to leave this surface dark.
    await act(async () => {
      capturedWsOnMessage!(toolMessage('m-t4', 'Bash: pnpm build', 5_000));
    });

    await waitFor(() => {
      expect(screen.getByTestId('tool-group-glyph')).toHaveAttribute('data-state', 'running');
    });
    expect(screen.getByText('· working')).toBeTruthy();
    // Liveness: the row in motion is the absorbed tail group, still one card.
    expect(screen.getByRole('button', { name: /4 tool calls/ })).toBeTruthy();
    expect(screen.getAllByTestId('tool-call-group')).toHaveLength(1);
  });

  /*
   * The same rendered-row prepend accounting as project chat, on this surface.
   * There is no "load earlier" button here — pagination fires from Virtuoso's
   * `startReached` when the reader scrolls to the top — so the test invokes that
   * callback, which is exactly what real Virtuoso does.
   */
  it('decrements firstItemIndex by the ROW delta when older history is prepended', async () => {
    mocks.getChatSession.mockResolvedValueOnce({
      session: {
        id: SESSION_ID,
        workspaceId: 'ws-1',
        topic: 'Workspace chat',
        status: 'active',
        messageCount: 2,
        createdAt: 1_000,
        endedAt: null,
      },
      messages: [
        textMessage('u1', 'user', 'What did you do?', 2_000),
        textMessage('m1', 'assistant', 'Quite a lot.', 2_100),
      ],
      hasMore: true,
    });
    // 3 assistant tokens fold into one bubble, 6 tool calls into one group:
    // 9 messages, 2 rows.
    mocks.getChatSession.mockResolvedValueOnce({
      session: {
        id: SESSION_ID,
        workspaceId: 'ws-1',
        topic: 'Workspace chat',
        status: 'active',
        messageCount: 11,
        createdAt: 1_000,
        endedAt: null,
      },
      messages: [
        textMessage('a1', 'assistant', 'Starting. ', 1_000),
        textMessage('a2', 'assistant', 'Still going. ', 1_100),
        textMessage('a3', 'assistant', 'Nearly there.', 1_200),
        toolMessage('t1', 'Bash: one', 1_300),
        toolMessage('t2', 'Bash: two', 1_400),
        toolMessage('t3', 'Bash: three', 1_500),
        toolMessage('t4', 'Bash: four', 1_600),
        toolMessage('t5', 'Bash: five', 1_700),
        toolMessage('t6', 'Bash: six', 1_800),
      ],
      hasMore: false,
    });

    renderView(<WorkspaceChatView projectId="proj-1" sessionId={SESSION_ID} />);
    await waitFor(() => {
      expect(virtuosoMock.lastProps.dataLength).toBe(2);
    });
    const before = virtuosoMock.lastProps.firstItemIndex!;
    expect(before).toBe(VIRTUAL_START);

    // Real trigger: Virtuoso reports the reader hit the top of the list.
    await act(async () => {
      virtuosoMock.lastProps.startReached!();
    });

    await waitFor(() => {
      expect(virtuosoMock.lastProps.dataLength).toBe(4);
    });
    // Exactly the rows added, not the 9 messages added.
    expect(before - virtuosoMock.lastProps.firstItemIndex!).toBe(2);
    // Liveness: the older page really rendered.
    expect(screen.getByRole('button', { name: /6 tool calls/ })).toBeTruthy();
  });

  /*
   * Pins the allow-set itself, independently of any group geometry.
   *
   * Project chat uses `msg.role !== 'user'`; this surface uses an explicit
   * `{assistant, thinking, tool}` set so SAM-injected `system` rows (lifecycle
   * notices, build logs) cannot light the indicator — notably right after
   * `onSessionStopped` has set it idle. Asserted on the "Agent is working..."
   * region rather than the card, because a `system` row also appends a display
   * row and would push the group off the tail, which would make a glyph-based
   * assertion pass for the wrong reason.
   *
   * Reverting the check to `=== 'assistant'` reddens the positive half;
   * widening it to `!== 'user'` reddens the negative half.
   */
  it('marks the agent working for agent rows but not for SAM system rows', async () => {
    renderView(<WorkspaceChatView projectId="proj-1" sessionId={SESSION_ID} />);
    await screen.findByRole('button', { name: /3 tool calls/ });
    expect(screen.queryByText('Agent is working...')).toBeNull();

    await act(async () => {
      capturedWsOnMessage!({
        id: 'm-sys',
        sessionId: SESSION_ID,
        role: 'system',
        content: 'Workspace stopped.',
        toolMetadata: null,
        createdAt: 5_000,
      });
    });
    expect(screen.queryByText('Agent is working...')).toBeNull();

    await act(async () => {
      capturedWsOnMessage!(toolMessage('m-t4', 'Bash: pnpm build', 6_000));
    });
    await waitFor(() => {
      expect(screen.getByText('Agent is working...')).toBeTruthy();
    });
  });
});
