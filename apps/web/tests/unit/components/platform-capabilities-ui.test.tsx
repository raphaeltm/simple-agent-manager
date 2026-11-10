/**
 * Voice input and server read-aloud follow the installation's platform capabilities, read
 * through the real query (`GET /api/config/platform-capabilities`), not a mocked hook.
 */
import type { ConversationItem } from '@simple-agent-manager/acp-client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ProjectChatComposer } from '../../../src/components/project-chat/ProjectChatComposer';
import { AcpConversationItemView } from '../../../src/components/project-message-view/AcpConversationItemView';
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

function withQueryClient(children: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
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
    const fetchMock = serveCapabilities(ASSUMED_PLATFORM_CAPABILITIES);
    render(composer());

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
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

    expect(await screen.findByLabelText('Read aloud')).toBeInTheDocument();
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
