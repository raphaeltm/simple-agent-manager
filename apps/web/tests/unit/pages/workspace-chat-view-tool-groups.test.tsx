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
   * F5b on this surface, made DISCRIMINATING.
   *
   * An earlier version hydrated `agentActivity='prompting'`, which
   * `isWorkingActivity` and `completionDockWorking` BOTH report as working — so
   * it passed against either predicate and proved nothing. `responding` is the
   * state that separates them, and the only way this view reaches it is an
   * assistant row through `onMessage` (this surface, unlike project chat, does
   * not move activity for tool rows).
   *
   * So: push assistant text (-> responding), then a further tool row, which
   * starts a NEW run and therefore a new TAIL group whose single call is already
   * `completed`. Nothing in that group's statuses can produce the running glyph;
   * only `groupLive` can. The settled first group is the built-in control that
   * `groupLive` stays scoped to the tail row.
   */
  it('puts the TAIL group in motion once the agent is responding', async () => {
    renderView(<WorkspaceChatView projectId="proj-1" sessionId={SESSION_ID} />);

    // Control: agent idle, every call settled -> the one glyph reads done.
    const glyph = await waitFor(() => screen.getByTestId('tool-group-glyph'));
    expect(glyph).toHaveAttribute('data-state', 'done');
    expect(screen.queryByText('· working')).toBeNull();

    // Real trigger #1: assistant text moves this surface to `responding`.
    await act(async () => {
      capturedWsOnMessage!(textMessage('m-a1', 'assistant', 'Running a few more checks.', 5_000));
    });
    // Real trigger #2: the next tool row opens a new run after that text, so the
    // tail display row is a group again.
    await act(async () => {
      capturedWsOnMessage!(toolMessage('m-t4', 'Bash: pnpm build', 6_000));
    });

    await waitFor(() => {
      const states = screen
        .getAllByTestId('tool-group-glyph')
        .map((el) => el.getAttribute('data-state'));
      expect(states).toEqual(['done', 'running']);
    });
    expect(screen.getByText('· working')).toBeTruthy();
    // Liveness: the tail really is the new single-call group, not a re-render of
    // the first one.
    expect(screen.getByRole('button', { name: /1 tool call/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /3 tool calls/ })).toBeTruthy();
  });
});
