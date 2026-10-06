import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChatMessageResponse } from '../../../src/lib/api';

vi.mock('../../../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getTtsApiUrl: () => 'https://api.example.test/tts',
}));

vi.mock('../../../src/contexts/GlobalAudioContext', () => ({
  useGlobalAudio: () => ({ startPlayback: vi.fn() }),
}));

// Imported after the mocks so the mocked modules are in place.
const { AcpConversationItemView } =
  await import('../../../src/components/project-message-view/AcpConversationItemView');
const { chatMessagesToConversationItems } =
  await import('../../../src/components/project-message-view/types');

const RAW_TEXT = 'Ship **the** `info` and copy buttons';

/**
 * Builds the row the way the chat does — persisted API message through the real
 * converter — so a converter or call site that drops the timestamp (which gates
 * the action row) fails here instead of passing on a hand-built item.
 */
function rowFor(overrides: Partial<ChatMessageResponse> = {}) {
  const [item] = chatMessagesToConversationItems([
    {
      id: 'msg-1',
      sessionId: 'sess-1',
      role: 'user',
      content: RAW_TEXT,
      toolMetadata: null,
      createdAt: 1_759_000_000_000,
      ...overrides,
    },
  ]);
  if (!item) throw new Error('converter produced no item');
  return item;
}

const writeText = vi.fn<(text: string) => Promise<void>>();

beforeEach(() => {
  writeText.mockReset();
  writeText.mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    writable: true,
    configurable: true,
  });
});

describe('AcpConversationItemView — user message actions', () => {
  it('gives a persisted user message Info and Copy, but not Read aloud', () => {
    const { container } = render(<AcpConversationItemView item={rowFor()} />);
    const bubble = container.querySelector<HTMLElement>('.glass-msg-user');
    expect(bubble).not.toBeNull();
    expect(within(bubble!).getByRole('button', { name: 'Message info' })).toBeVisible();
    expect(within(bubble!).getByRole('button', { name: 'Copy message' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Read aloud' })).toBeNull();
  });

  it('copies the raw message text, markdown included', async () => {
    render(<AcpConversationItemView item={rowFor()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy message' }));
    expect(writeText).toHaveBeenCalledWith(RAW_TEXT);
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeVisible();
  });

  it('shows the message metadata from Info', () => {
    render(<AcpConversationItemView item={rowFor({ content: 'Ship it now' })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Message info' }));
    const dialog = screen.getByRole('dialog', { name: 'Message metadata' });
    expect(dialog).toHaveTextContent('Time:');
    expect(dialog).toHaveTextContent('Words: 3');
    expect(dialog).toHaveTextContent('Characters: 11');
  });

  it('gives a just-sent message both buttons while it is still fading in', () => {
    const { container } = render(
      <AcpConversationItemView item={rowFor({ id: 'optimistic-1' })} animateUserMessage />
    );
    expect(container.querySelectorAll('.glass-msg-user .char-fade').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Message info' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Copy message' })).toBeVisible();
  });

  it('gives SAM-injected context no message actions', () => {
    const { container } = render(<AcpConversationItemView item={rowFor({ origin: 'system' })} />);
    expect(container.querySelector('details.sam-injected-message')).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Message info' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Copy message' })).toBeNull();
  });

  it('keeps all three buttons on agent messages', () => {
    render(<AcpConversationItemView item={rowFor({ id: 'agent-1', role: 'assistant' })} />);
    expect(screen.getByRole('button', { name: 'Message info' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Read aloud' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Copy message' })).toBeVisible();
  });
});
