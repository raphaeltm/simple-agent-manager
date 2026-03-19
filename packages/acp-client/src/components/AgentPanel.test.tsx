import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { AgentPanel, CLIENT_COMMANDS } from './AgentPanel';
import type { AcpSessionHandle } from '../hooks/useAcpSession';
import type { AcpMessagesHandle } from '../hooks/useAcpMessages';
import type { ConversationItem } from '../hooks/useAcpMessages';
import type { SlashCommand } from '../types';

// Mock react-virtuoso — JSDOM has no layout engine, so Virtuoso can't measure items.
// This mock renders all items inline so content-based tests work normally.
vi.mock('react-virtuoso', () => ({
  Virtuoso: React.forwardRef(function MockVirtuoso(
    { data, itemContent, style }: { data?: unknown[]; itemContent?: (index: number, item: unknown) => React.ReactNode; style?: React.CSSProperties },
    _ref: React.Ref<unknown>,
  ) {
    return React.createElement('div', { 'data-testid': 'virtuoso-scroller', style },
      data?.map((item, index) =>
        React.createElement('div', { key: index }, itemContent?.(index, item))
      )
    );
  }),
}));

function createMockSession(overrides: Partial<AcpSessionHandle> = {}): AcpSessionHandle {
  return {
    state: 'ready',
    connected: true,
    agentType: 'claude-code',
    switchAgent: vi.fn(),
    sendMessage: vi.fn(),
    error: null,
    ...overrides,
  } as AcpSessionHandle;
}

function createMockMessages(overrides: Partial<AcpMessagesHandle> = {}): AcpMessagesHandle {
  return {
    items: [],
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    availableCommands: [],
    processMessage: vi.fn(),
    addUserMessage: vi.fn(),
    clear: vi.fn(),
    prepareForReplay: vi.fn(),
    ...overrides,
  };
}

describe('AgentPanel slash command integration', () => {
  it('shows palette when input starts with /', () => {
    const session = createMockSession();
    const messages = createMockMessages();

    render(<AgentPanel session={session} messages={messages} />);

    const textarea = screen.getByPlaceholderText(/type \/ for commands/i);
    fireEvent.change(textarea, { target: { value: '/' } });

    // Should show the client commands in the palette
    expect(screen.getByText('/clear')).toBeTruthy();
    expect(screen.getByText('/copy')).toBeTruthy();
    expect(screen.getByText('/export')).toBeTruthy();
  });

  it('hides palette when input does not start with /', () => {
    const session = createMockSession();
    const messages = createMockMessages();

    render(<AgentPanel session={session} messages={messages} />);

    const textarea = screen.getByPlaceholderText(/type \/ for commands/i);
    fireEvent.change(textarea, { target: { value: 'hello' } });

    // Palette should not be visible
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('hides palette when input has a space after the command', () => {
    const session = createMockSession();
    const messages = createMockMessages();

    render(<AgentPanel session={session} messages={messages} />);

    const textarea = screen.getByPlaceholderText(/type \/ for commands/i);
    fireEvent.change(textarea, { target: { value: '/clear args' } });

    // Palette should not be visible (space after command)
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('filters commands as user types after /', () => {
    const session = createMockSession();
    const messages = createMockMessages();

    render(<AgentPanel session={session} messages={messages} />);

    const textarea = screen.getByPlaceholderText(/type \/ for commands/i);
    fireEvent.change(textarea, { target: { value: '/cl' } });

    expect(screen.getByText('/clear')).toBeTruthy();
    expect(screen.queryByText('/copy')).toBeNull();
    expect(screen.queryByText('/export')).toBeNull();
  });

  it('shows agent commands when availableCommands prop is provided', () => {
    const session = createMockSession();
    const messages = createMockMessages();
    const agentCommands: SlashCommand[] = [
      { name: 'compact', description: 'Compress context', source: 'agent' },
    ];

    render(
      <AgentPanel
        session={session}
        messages={messages}
        availableCommands={agentCommands}
      />
    );

    const textarea = screen.getByPlaceholderText(/type \/ for commands/i);
    fireEvent.change(textarea, { target: { value: '/' } });

    // Should show agent commands alongside client commands
    expect(screen.getByText('/compact')).toBeTruthy();
    expect(screen.getByText('/clear')).toBeTruthy();
  });

  it('intercepts client /clear command and calls messages.clear()', () => {
    const session = createMockSession();
    const clear = vi.fn();
    const messages = createMockMessages({ clear });

    render(<AgentPanel session={session} messages={messages} />);

    const textarea = screen.getByPlaceholderText(/type \/ for commands/i);
    const form = textarea.closest('form')!;

    fireEvent.change(textarea, { target: { value: '/clear' } });
    fireEvent.submit(form);

    expect(clear).toHaveBeenCalled();
    // Should NOT send to agent
    expect(session.sendMessage).not.toHaveBeenCalled();
  });

  it('sends agent commands to the agent normally', () => {
    const session = createMockSession();
    const messages = createMockMessages();

    render(<AgentPanel session={session} messages={messages} />);

    const textarea = screen.getByPlaceholderText(/type \/ for commands/i);
    const form = textarea.closest('form')!;

    // Type an unknown slash command (not a client command)
    fireEvent.change(textarea, { target: { value: '/compact' } });
    fireEvent.submit(form);

    // Should be sent to the agent
    expect(messages.addUserMessage).toHaveBeenCalledWith('/compact');
    expect(session.sendMessage).toHaveBeenCalled();
  });

  it('updates placeholder to mention slash commands', () => {
    const session = createMockSession();
    const messages = createMockMessages();

    render(<AgentPanel session={session} messages={messages} />);

    expect(screen.getByPlaceholderText(/type \/ for commands/i)).toBeTruthy();
  });

  it('has min 44px touch target on Send button', () => {
    const session = createMockSession();
    const messages = createMockMessages();

    render(<AgentPanel session={session} messages={messages} />);

    const sendButton = screen.getByText('Send');
    expect(sendButton.style.minHeight).toBe('44px');
  });
});

describe('CLIENT_COMMANDS', () => {
  it('defines expected client commands', () => {
    expect(CLIENT_COMMANDS).toHaveLength(3);
    expect(CLIENT_COMMANDS.map((c) => c.name)).toEqual(['clear', 'copy', 'export']);
    expect(CLIENT_COMMANDS.every((c) => c.source === 'client')).toBe(true);
  });
});

// =============================================================================
// Virtual scroll message rendering tests
// =============================================================================

describe('AgentPanel virtualized message rendering', () => {
  it('renders messages via Virtuoso', () => {
    const session = createMockSession();
    const items: ConversationItem[] = [
      { kind: 'user_message', id: '1', text: 'Hello', timestamp: Date.now() },
      { kind: 'agent_message', id: '2', text: 'Hi there', streaming: false, timestamp: Date.now() },
    ];
    const messages = createMockMessages({ items });

    render(<AgentPanel session={session} messages={messages} />);

    // Virtuoso mock renders all items
    expect(screen.getByTestId('virtuoso-scroller')).toBeTruthy();
    expect(screen.getByText('Hello')).toBeTruthy();
    expect(screen.getByText('Hi there')).toBeTruthy();
  });

  it('renders messages in the scroll container', () => {
    const session = createMockSession();
    const items: ConversationItem[] = [
      { kind: 'user_message', id: '1', text: 'First message', timestamp: Date.now() },
      { kind: 'agent_message', id: '2', text: 'Response', streaming: false, timestamp: Date.now() },
      { kind: 'user_message', id: '3', text: 'Second message', timestamp: Date.now() },
    ];
    const messages = createMockMessages({ items });

    render(<AgentPanel session={session} messages={messages} />);

    expect(screen.getByText('First message')).toBeTruthy();
    expect(screen.getByText('Response')).toBeTruthy();
    expect(screen.getByText('Second message')).toBeTruthy();
  });

  it('shows empty state when no messages', () => {
    const session = createMockSession();
    const messages = createMockMessages({ items: [] });

    render(<AgentPanel session={session} messages={messages} />);

    expect(screen.getByText('Send a message to start the conversation')).toBeTruthy();
  });

  it('uses Virtuoso for rendering messages', () => {
    const session = createMockSession();
    const items: ConversationItem[] = [
      { kind: 'user_message', id: '1', text: 'Msg 1', timestamp: Date.now() },
      { kind: 'agent_message', id: '2', text: 'Reply', streaming: false, timestamp: Date.now() },
    ];
    const messages = createMockMessages({ items });

    render(<AgentPanel session={session} messages={messages} />);

    // Verify Virtuoso mock is rendered with items
    expect(screen.getByTestId('virtuoso-scroller')).toBeTruthy();
    expect(screen.getByText('Msg 1')).toBeTruthy();
    expect(screen.getByText('Reply')).toBeTruthy();
  });

  it('renders streaming messages correctly in scroll container', () => {
    const session = createMockSession();
    const items: ConversationItem[] = [
      { kind: 'user_message', id: '1', text: 'Question', timestamp: Date.now() },
      { kind: 'agent_message', id: '2', text: 'Partial response...', streaming: true, timestamp: Date.now() },
    ];
    const messages = createMockMessages({ items });

    render(<AgentPanel session={session} messages={messages} />);

    expect(screen.getByText('Question')).toBeTruthy();
    // Streaming message should render its text
    expect(screen.getByText(/Partial response/)).toBeTruthy();
  });
});

// =============================================================================
// Toolbar row tests
// =============================================================================

describe('AgentPanel toolbar row', () => {
  let originalResizeObserver: typeof ResizeObserver;
  let originalMutationObserver: typeof MutationObserver;

  beforeEach(() => {
    originalResizeObserver = globalThis.ResizeObserver;
    originalMutationObserver = globalThis.MutationObserver;
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
    globalThis.MutationObserver = class {
      observe() {}
      disconnect() {}
      takeRecords() { return []; }
    } as unknown as typeof MutationObserver;
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      cb(performance.now());
      return 1;
    });
  });

  afterEach(() => {
    globalThis.ResizeObserver = originalResizeObserver;
    globalThis.MutationObserver = originalMutationObserver;
    vi.restoreAllMocks();
  });

  it('renders settings button in toolbar when onSaveSettings provided', () => {
    const session = createMockSession();
    const messages = createMockMessages();

    render(
      <AgentPanel
        session={session}
        messages={messages}
        onSaveSettings={vi.fn()}
        permissionModes={[{ value: 'default', label: 'Default' }]}
      />
    );

    const settingsButton = screen.getByLabelText('Agent settings');
    expect(settingsButton).toBeTruthy();
    expect(screen.getByText('Settings')).toBeTruthy();
  });

  it('cancel button is always visible even when not prompting', () => {
    const session = createMockSession({ state: 'ready' });
    const messages = createMockMessages();

    render(<AgentPanel session={session} messages={messages} />);

    const cancelButton = screen.getByLabelText('Cancel agent');
    expect(cancelButton).toBeTruthy();
    expect(screen.getByText('Cancel')).toBeTruthy();
  });

  it('cancel button sends session/cancel when clicked', () => {
    const sendMessage = vi.fn();
    const session = createMockSession({ sendMessage });
    const messages = createMockMessages();

    render(<AgentPanel session={session} messages={messages} />);

    fireEvent.click(screen.getByLabelText('Cancel agent'));
    expect(sendMessage).toHaveBeenCalledWith({
      jsonrpc: '2.0',
      method: 'session/cancel',
      params: {},
    });
  });

  it('cancel button has red styling when prompting', () => {
    const session = createMockSession({ state: 'prompting' });
    const messages = createMockMessages();

    render(<AgentPanel session={session} messages={messages} />);

    const cancelButton = screen.getByLabelText('Cancel agent');
    expect(cancelButton.className).toContain('border-red-300');
    expect(cancelButton.className).toContain('text-red-600');
  });

  it('cancel button has muted styling when not prompting', () => {
    const session = createMockSession({ state: 'ready' });
    const messages = createMockMessages();

    render(<AgentPanel session={session} messages={messages} />);

    const cancelButton = screen.getByLabelText('Cancel agent');
    expect(cancelButton.className).toContain('text-gray-400');
  });

  it('settings button is not inside the form element', () => {
    const session = createMockSession();
    const messages = createMockMessages();

    render(
      <AgentPanel
        session={session}
        messages={messages}
        onSaveSettings={vi.fn()}
        permissionModes={[{ value: 'default', label: 'Default' }]}
      />
    );

    const settingsButton = screen.getByLabelText('Agent settings');
    const form = screen.getByPlaceholderText(/type \/ for commands/i).closest('form');
    expect(form!.contains(settingsButton)).toBe(false);
  });
});

// =============================================================================
// Scroll reset on replay tests
// =============================================================================

describe('AgentPanel scroll reset on replay', () => {
  it('renders empty state when items are cleared (replay)', () => {
    const session = createMockSession();
    const items: ConversationItem[] = [
      { kind: 'user_message', id: '1', text: 'Hello', timestamp: Date.now() },
    ];
    const messages = createMockMessages({ items });

    const { rerender } = render(<AgentPanel session={session} messages={messages} />);
    expect(screen.getByText('Hello')).toBeTruthy();

    // Simulate prepareForReplay clearing items
    const clearedMessages = createMockMessages({ items: [] });
    rerender(<AgentPanel session={session} messages={clearedMessages} />);

    // Should show empty state instead of Virtuoso
    expect(screen.getByText(/Send a message/i)).toBeTruthy();
    expect(screen.queryByText('Hello')).toBeNull();
  });

  it('re-renders items after replay completes (replaying → ready)', () => {
    const session = createMockSession({ state: 'replaying' as AcpSessionHandle['state'] });
    const messages = createMockMessages();

    const { rerender } = render(<AgentPanel session={session} messages={messages} />);

    // Transition replaying → ready with new items
    const readySession = createMockSession({ state: 'ready' });
    const newItems: ConversationItem[] = [
      { kind: 'agent_message', id: '2', text: 'Replayed', streaming: false, timestamp: Date.now() },
    ];
    rerender(<AgentPanel session={readySession} messages={createMockMessages({ items: newItems })} />);

    expect(screen.getByText('Replayed')).toBeTruthy();
  });

  it('re-renders items after replay completes (replaying → prompting)', () => {
    const session = createMockSession({ state: 'replaying' as AcpSessionHandle['state'] });
    const messages = createMockMessages();

    const { rerender } = render(<AgentPanel session={session} messages={messages} />);

    // Transition replaying → prompting with new items
    const promptingSession = createMockSession({ state: 'prompting' });
    const newItems: ConversationItem[] = [
      { kind: 'agent_message', id: '2', text: 'Replayed prompting', streaming: false, timestamp: Date.now() },
    ];
    rerender(<AgentPanel session={promptingSession} messages={createMockMessages({ items: newItems })} />);

    expect(screen.getByText('Replayed prompting')).toBeTruthy();
  });
});

// =============================================================================
// Scroll-to-bottom FAB tests
// =============================================================================

describe('AgentPanel scroll-to-bottom FAB', () => {
  // Note: With Virtuoso, isAtBottom is managed internally via atBottomStateChange.
  // In JSDOM the mock Virtuoso never fires atBottomStateChange, so isAtBottom stays true (initial).
  // We test structural presence — the FAB is hidden by default since isAtBottom starts true.

  it('hides scroll-to-bottom button by default (at bottom)', () => {
    const session = createMockSession();
    const items: ConversationItem[] = [
      { kind: 'user_message', id: '1', text: 'Hello', timestamp: Date.now() },
    ];
    const messages = createMockMessages({ items });

    render(<AgentPanel session={session} messages={messages} />);

    // isAtBottom starts true, so FAB should be hidden
    expect(screen.queryByLabelText('Scroll to bottom')).toBeNull();
  });

  it('hides scroll-to-bottom button when no messages', () => {
    const session = createMockSession();
    const messages = createMockMessages({ items: [] });

    render(<AgentPanel session={session} messages={messages} />);

    expect(screen.queryByLabelText('Scroll to bottom')).toBeNull();
  });
});
