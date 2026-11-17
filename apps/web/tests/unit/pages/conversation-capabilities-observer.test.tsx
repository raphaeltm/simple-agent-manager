/**
 * A conversation reads the platform capabilities once, at the list, and passes the primitive
 * `serverTextToSpeech` to every row. Before, every `AcpConversationItemView` called
 * `usePlatformCapabilities()` itself: each mounted row was a query observer, and each re-rendered
 * when the capabilities fetch resolved, even when the answer matched what was assumed.
 *
 * Entered through the real view and the real capabilities query (`GET
 * /api/config/platform-capabilities`), held on a deferred response so the test controls when it
 * resolves (rule 62).
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { platformCapabilitiesQueryKeys } from '../../../src/lib/query-options/platform-capabilities';

const mocks = vi.hoisted(() => ({
  getChatSession: vi.fn(),
  getChatSessionState: vi.fn(),
  bubbleRenders: new Map<string, number>(),
  bubbleTts: new Map<string, string | undefined>(),
}));

vi.mock('../../../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/api')>()),
  getChatSession: mocks.getChatSession,
  getChatSessionState: mocks.getChatSessionState,
  getTranscribeApiUrl: vi.fn(() => 'https://api.test/api/transcribe'),
  getTtsApiUrl: vi.fn(() => 'https://api.test/api/tts'),
  resetIdleTimer: vi.fn(),
  sendFollowUpPrompt: vi.fn(),
  uploadSessionFiles: vi.fn(),
  cancelAgentPrompt: vi.fn(),
}));

vi.mock('../../../src/hooks/useChatWebSocket', () => ({
  useChatWebSocket: () => ({
    connectionState: 'connected',
    wsRef: { current: null },
    retry: vi.fn(),
  }),
}));

vi.mock('../../../src/contexts/GlobalAudioContext', () => ({
  useGlobalAudio: () => ({ startPlayback: vi.fn() }),
}));

vi.mock('react-virtuoso', async () => {
  const { createVirtuosoModuleMock } = await import('../../helpers/virtuoso-mock');
  return createVirtuosoModuleMock();
});

// Counts renders per message bubble: a direct measure of row re-renders.
vi.mock('@simple-agent-manager/acp-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@simple-agent-manager/acp-client')>();
  return {
    ...actual,
    MessageBubble: ({
      text,
      role,
      ttsApiUrl,
    }: {
      text: string;
      role: string;
      ttsApiUrl?: string;
    }) => {
      mocks.bubbleRenders.set(text, (mocks.bubbleRenders.get(text) ?? 0) + 1);
      mocks.bubbleTts.set(text, ttsApiUrl);
      return <div data-testid={`acp-message-${role}`}>{text}</div>;
    },
  };
});

const { WorkspaceChatView } = await import('../../../src/pages/workspace/WorkspaceChatView');
const { resetVirtuosoMock } = await import('../../helpers/virtuoso-mock');

const SESSION_ID = 'ws-session-observers';

/** Alternating turns, so every message is its own row (consecutive agent text merges). */
function message(index: number) {
  const agent = index % 2 === 1;
  return {
    id: `m-${index}`,
    sessionId: SESSION_ID,
    role: agent ? ('assistant' as const) : ('user' as const),
    content: agent ? `Agent reply number ${index}` : `User turn number ${index}`,
    toolMetadata: null,
    createdAt: 1_000 + index,
    sequence: 1_000 + index,
  };
}

/** Serve the capabilities endpoint on a deferred response the test releases. */
function holdCapabilities(): (body: Record<string, boolean>) => void {
  let release!: (body: Record<string, boolean>) => void;
  const answer = new Promise<Record<string, boolean>>((resolve) => {
    release = resolve;
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/config/platform-capabilities')) return Response.json(await answer);
      throw new Error(`unexpected request ${url}`);
    })
  );
  return release;
}

/**
 * The observer count once the conversation has finished mounting: two equal readings a tick
 * apart. A reading taken the moment the last row appears can precede a reader that mounts a
 * little later (under a loaded full suite the short render was sampled at 1, the long at 2).
 */
async function steadyObservers(read: () => number): Promise<number> {
  let last = -1;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
    const now = read();
    if (now === last) return now;
    last = now;
  }
  return last;
}

function renderConversation(messageCount: number) {
  mocks.getChatSession.mockResolvedValue({
    session: {
      id: SESSION_ID,
      workspaceId: 'ws-1',
      topic: 'Long conversation',
      status: 'active',
      messageCount,
      createdAt: 1_000,
      endedAt: null,
    },
    messages: Array.from({ length: messageCount }, (_, index) => message(index)),
    hasMore: false,
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
  const view = render(<WorkspaceChatView projectId="proj-1" sessionId={SESSION_ID} />, {
    wrapper,
  });
  const observers = () =>
    client
      .getQueryCache()
      .find({ queryKey: platformCapabilitiesQueryKeys.all() })
      ?.getObserversCount() ?? 0;
  const settled = () =>
    client.getQueryCache().find({ queryKey: platformCapabilitiesQueryKeys.all() })?.state.status ===
    'success';
  return { view, observers, settled };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetVirtuosoMock();
  mocks.bubbleRenders.clear();
  mocks.bubbleTts.clear();
  mocks.getChatSessionState.mockResolvedValue({
    state: null,
    agentSessionId: null,
    agentType: null,
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('conversation capability reads', () => {
  it('keeps the number of capabilities observers independent of conversation length', async () => {
    holdCapabilities();
    const short = renderConversation(2);
    await screen.findByText('Agent reply number 1');
    const shortObservers = await steadyObservers(short.observers);
    short.view.unmount();

    holdCapabilities();
    const long = renderConversation(40);
    await screen.findByText('Agent reply number 39');
    expect(screen.getAllByTestId(/^acp-message-/)).toHaveLength(40);

    // The list reads once; 38 more rows add no observer.
    const longObservers = await steadyObservers(long.observers);
    expect(longObservers).toBe(shortObservers);
    expect(longObservers).toBeLessThanOrEqual(2);
  });

  it('does not re-render the rows when the capabilities resolve to what was assumed', async () => {
    const release = holdCapabilities();
    const { settled } = renderConversation(40);
    await screen.findByText('Agent reply number 39');
    const before = new Map(mocks.bubbleRenders);

    await act(async () => {
      release({ speechToText: true, textToSpeech: true, monthlyCostCap: true });
    });
    await waitFor(() => expect(settled()).toBe(true));

    expect(mocks.bubbleRenders).toEqual(before);
    // Liveness: the rows really offer server read-aloud.
    expect(mocks.bubbleTts.get('Agent reply number 1')).toBe('https://api.test/api/tts');
  });

  it('updates every row when server read-aloud turns out to be absent (control)', async () => {
    const release = holdCapabilities();
    const { settled } = renderConversation(40);
    await screen.findByText('Agent reply number 39');

    await act(async () => {
      release({ speechToText: false, textToSpeech: false, monthlyCostCap: false });
    });
    await waitFor(() => expect(settled()).toBe(true));

    const agentReplies = [...mocks.bubbleTts.keys()].filter((text) => text.startsWith('Agent'));
    expect(agentReplies).toHaveLength(20);
    await waitFor(() =>
      expect(agentReplies.every((text) => mocks.bubbleTts.get(text) === undefined)).toBe(true)
    );
  });
});
