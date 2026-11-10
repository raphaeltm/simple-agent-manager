/**
 * Voice input and server read-aloud follow the installation's platform capabilities, read
 * through the real query (`GET /api/config/platform-capabilities`), not a mocked hook.
 */
import type { ConversationItem } from '@simple-agent-manager/acp-client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createRef, type ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TruncatedSummary } from '../../../src/components/chat/TruncatedSummary';
import { ProjectChatComposer } from '../../../src/components/project-chat/ProjectChatComposer';
import { AcpConversationItemView } from '../../../src/components/project-message-view/AcpConversationItemView';
import { CommentComposer } from '../../../src/components/project-message-view/comments/CommentComposer';
import { SamComposer } from '../../../src/components/sam/SamComposer';
import { ProjectAgentChat } from '../../../src/pages/ProjectAgentChat';
import {
  ASSUMED_PLATFORM_CAPABILITIES,
  getPlatformCapabilities,
} from '../../../src/lib/api/platform-capabilities';

vi.mock('@simple-agent-manager/acp-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@simple-agent-manager/acp-client')>();
  return {
    ...actual,
    VoiceButton: () => (
      <button type="button" data-testid="voice-button">
        Voice
      </button>
    ),
  };
});

vi.mock('../../../src/contexts/GlobalAudioContext', () => ({
  useGlobalAudio: () => ({ startPlayback: vi.fn() }),
}));

// ProjectAgentChat's own data and canvas hooks; the capabilities query stays real.
vi.mock('../../../src/hooks/useAgentChat', () => ({
  useAgentChat: () => ({
    messages: [],
    inputValue: '',
    setInputValue: vi.fn(),
    isSending: false,
    isLoading: false,
    error: null,
    sendMessage: vi.fn(),
    stop: vi.fn(),
    clearError: vi.fn(),
  }),
}));
vi.mock('../../../src/pages/ProjectContext', () => ({
  useProjectContext: () => ({ project: { name: 'Billing' } }),
}));
vi.mock('../../../src/pages/sam-prototype/webgl-background', () => ({
  useWebGLBackground: vi.fn(),
}));
vi.mock('../../../src/pages/sam-prototype/voice-input', () => ({
  useVoiceInput: () => ({ state: 'idle', toggle: vi.fn() }),
}));

Element.prototype.scrollIntoView = vi.fn();

const SELF_HOST = { ...ASSUMED_PLATFORM_CAPABILITIES, speechToText: false, textToSpeech: false };

/** Serve the capabilities endpoint; every other request fails loudly. */
function serveCapabilities(body: unknown, status = 200) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/api/config/platform-capabilities')) {
      return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    throw new Error(`unexpected request ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

let client: QueryClient;

function withQueryClient(children: ReactNode) {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

/**
 * Waits until the capabilities query has answered. Without this, a "still shown" assertion
 * passes on the assumed-present default before the server's answer is ever applied.
 */
async function capabilitiesSettled() {
  await waitFor(() =>
    expect(client.getQueryCache().getAll().every((query) => query.state.status === 'success')).toBe(
      true
    )
  );
  expect(client.getQueryCache().getAll().length).toBeGreaterThan(0);
}

function composer() {
  return withQueryClient(
    <ProjectChatComposer
      value=""
      onChange={vi.fn()}
      onSend={vi.fn()}
      sending={false}
      placeholder="Send a message..."
      transcribeApiUrl="/api/transcribe"
    />
  );
}

const AGENT_MESSAGE = {
  kind: 'agent_message',
  id: 'msg-1',
  text: 'Done: the migration is applied.',
  streaming: false,
  timestamp: 1_787_000_000_000,
} as ConversationItem;

function agentBubble() {
  return withQueryClient(<AcpConversationItemView item={AGENT_MESSAGE} />);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('voice input', () => {
  it('is hidden when the installation has no speech-to-text', async () => {
    const fetchMock = serveCapabilities(SELF_HOST);
    render(composer());

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByTestId('voice-button')).toBeNull());
    // Liveness: the composer itself rendered.
    expect(screen.getByRole('combobox')).toBeInTheDocument();
  });

  it('stays visible when the installation has speech-to-text', async () => {
    serveCapabilities(ASSUMED_PLATFORM_CAPABILITIES);
    render(composer());

    await capabilitiesSettled();
    expect(screen.getByTestId('voice-button')).toBeInTheDocument();
  });
});

describe('server read-aloud', () => {
  it('drops the speaker when there is no server TTS (jsdom has no browser speech either)', async () => {
    serveCapabilities(SELF_HOST);
    render(agentBubble());

    await waitFor(() => expect(screen.queryByLabelText('Read aloud')).toBeNull());
    expect(screen.getByText(/the migration is applied/)).toBeInTheDocument();
  });

  it('keeps the speaker when the installation has server TTS', async () => {
    serveCapabilities(ASSUMED_PLATFORM_CAPABILITIES);
    render(agentBubble());

    await capabilitiesSettled();
    expect(screen.getByLabelText('Read aloud')).toBeInTheDocument();
  });
});

const SELF_HOST_STT_ONLY_OFF = { ...ASSUMED_PLATFORM_CAPABILITIES, speechToText: false };

function samComposer() {
  return withQueryClient(
    <SamComposer
      message=""
      setMessage={vi.fn()}
      onSend={vi.fn()}
      onStop={vi.fn()}
      active={false}
      sending={false}
      cancelling={false}
      pending={false}
      blocked={false}
      error={null}
      textareaRef={createRef<HTMLTextAreaElement>()}
    />
  );
}

function commentComposer() {
  return withQueryClient(<CommentComposer onSubmit={vi.fn()} onCancel={vi.fn()} />);
}

function projectAgentChat() {
  return withQueryClient(
    <MemoryRouter initialEntries={['/projects/p1/agent']}>
      <Routes>
        <Route path="/projects/:id/agent" element={<ProjectAgentChat />} />
      </Routes>
    </MemoryRouter>
  );
}

/** Each composer that offers voice input, with what proves it rendered. */
const VOICE_SURFACES: Array<{
  name: string;
  render: () => ReactNode;
  mic: () => HTMLElement | null;
  live: () => HTMLElement;
}> = [
  {
    name: 'SAM composer',
    render: samComposer,
    mic: () => screen.queryByTestId('voice-button'),
    live: () => screen.getByRole('textbox'),
  },
  {
    name: 'comment composer',
    render: commentComposer,
    mic: () => screen.queryByTestId('voice-button'),
    live: () => screen.getByRole('button', { name: 'Comment' }),
  },
  {
    name: 'project agent chat',
    render: projectAgentChat,
    mic: () => screen.queryByRole('button', { name: 'Start voice input' }),
    live: () => screen.getByRole('textbox'),
  },
];

describe.each(VOICE_SURFACES)('voice input in the $name', ({ render: build, mic, live }) => {
  it('is hidden without speech-to-text', async () => {
    serveCapabilities(SELF_HOST_STT_ONLY_OFF);
    render(build());
    await capabilitiesSettled();
    expect(mic()).toBeNull();
    expect(live()).toBeInTheDocument();
  });

  it('is offered with speech-to-text', async () => {
    serveCapabilities(ASSUMED_PLATFORM_CAPABILITIES);
    render(build());
    await capabilitiesSettled();
    expect(mic()).not.toBeNull();
    expect(live()).toBeInTheDocument();
  });
});

describe('task summary read-aloud', () => {
  function openTruncatedSummary() {
    let observed: ResizeObserverCallback | null = null;
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(cb: ResizeObserverCallback) {
          observed = cb;
        }
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    );
    const result = render(
      withQueryClient(<TruncatedSummary summary={'A long summary. '.repeat(20)} taskId="t1" />)
    );
    const text = result.container.querySelector('.line-clamp-2')!;
    Object.defineProperty(text, 'scrollHeight', { value: 100, configurable: true });
    Object.defineProperty(text, 'clientHeight', { value: 40, configurable: true });
    act(() => observed?.([], {} as ResizeObserver));
    fireEvent.click(screen.getByText('Read more'));
  }

  it('drops the speaker without server TTS', async () => {
    serveCapabilities(SELF_HOST);
    openTruncatedSummary();
    await capabilitiesSettled();
    expect(screen.queryByLabelText('Read summary aloud')).toBeNull();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('keeps the speaker with server TTS', async () => {
    serveCapabilities(ASSUMED_PLATFORM_CAPABILITIES);
    openTruncatedSummary();
    await capabilitiesSettled();
    expect(screen.getByLabelText('Read summary aloud')).toBeInTheDocument();
  });
});

describe('getPlatformCapabilities', () => {
  it('assumes every service when the API predates the endpoint', async () => {
    serveCapabilities({ error: 'NOT_FOUND' }, 404);
    await expect(getPlatformCapabilities()).resolves.toEqual(ASSUMED_PLATFORM_CAPABILITIES);
  });

  it('reads known boolean fields only', async () => {
    serveCapabilities({ speechToText: false, textToSpeech: 'no', extra: true });
    await expect(getPlatformCapabilities()).resolves.toEqual({
      ...ASSUMED_PLATFORM_CAPABILITIES,
      speechToText: false,
    });
  });
});
