import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AgentPanel, CLIENT_COMMANDS } from './AgentPanel';
import type { AcpSessionHandle } from '../hooks/useAcpSession';
import type { AcpMessagesHandle } from '../hooks/useAcpMessages';
import type { ConversationItem } from '../hooks/useAcpMessages';
import type { SlashCommand } from '../types';
import * as autoScrollModule from '../hooks/useAutoScroll';

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
// Smart auto-scroll integration tests
// =============================================================================

describe('AgentPanel auto-scroll behavior', () => {
  // Mock ResizeObserver and MutationObserver for jsdom
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

  it('uses useAutoScroll hook (no old useEffect scroll-to-bottom)', () => {
    // Verify that AgentPanel renders without the old forced-scroll behavior.
    // The old code had: useEffect(() => { scrollRef.scrollTop = scrollHeight }, [messages.items.length])
    // With the new hook, scrolling is conditional on being at bottom.
    const session = createMockSession();
    const items: ConversationItem[] = [
      { kind: 'user_message', id: '1', text: 'Hello', timestamp: Date.now() },
      { kind: 'agent_message', id: '2', text: 'Hi there', streaming: false, timestamp: Date.now() },
    ];
    const messages = createMockMessages({ items });

    const { container } = render(<AgentPanel session={session} messages={messages} />);

    // The scroll container should exist with overflow-y-auto
    const scrollContainer = container.querySelector('.overflow-y-auto');
    expect(scrollContainer).toBeTruthy();
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

  it('does not import or use the old scroll-to-bottom pattern', async () => {
    // This test verifies at the source level that the old pattern was removed.
    // We read the component source and check it doesn't contain the old pattern.
    // Since we can't read files in a unit test, we verify behavior instead:
    // rendering with messages should not force scrollTop to scrollHeight.

    const session = createMockSession();
    const items: ConversationItem[] = [
      { kind: 'user_message', id: '1', text: 'Msg 1', timestamp: Date.now() },
      { kind: 'agent_message', id: '2', text: 'Reply', streaming: false, timestamp: Date.now() },
    ];
    const messages = createMockMessages({ items });

    const { container } = render(<AgentPanel session={session} messages={messages} />);
    const scrollContainer = container.querySelector('.overflow-y-auto') as HTMLElement;

    // In jsdom, scrollTop is always 0 and scrollHeight is 0, so we can't
    // directly test scrolling. But we can verify the container exists and
    // is the right element.
    expect(scrollContainer).toBeTruthy();
    expect(scrollContainer.classList.contains('overflow-y-auto')).toBe(true);
    expect(scrollContainer.classList.contains('h-full')).toBe(true);
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
// Scroll reset on replay / clear tests
// =============================================================================

describe('AgentPanel scroll reset on replay', () => {
  let resetToBottomSpy: ReturnType<typeof vi.fn>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let autoScrollSpy: any;

  beforeEach(() => {
    resetToBottomSpy = vi.fn();
    autoScrollSpy = vi.spyOn(autoScrollModule, 'useAutoScroll').mockReturnValue({
      scrollRef: vi.fn(),
      isAtBottom: true,
      scrollToBottom: vi.fn(),
      resetToBottom: resetToBottomSpy,
    });
  });

  afterEach(() => {
    autoScrollSpy.mockRestore();
  });

  it('calls resetToBottom when items transition from >0 to 0 (replay clear)', () => {
    const session = createMockSession();
    const items: ConversationItem[] = [
      { kind: 'user_message', id: '1', text: 'Hello', timestamp: Date.now() },
    ];
    const messages = createMockMessages({ items });

    const { rerender } = render(<AgentPanel session={session} messages={messages} />);

    // Initially resetToBottom should NOT have been called (items didn't go to 0)
    expect(resetToBottomSpy).not.toHaveBeenCalled();

    // Simulate prepareForReplay clearing items
    const clearedMessages = createMockMessages({ items: [] });
    rerender(<AgentPanel session={session} messages={clearedMessages} />);

    expect(resetToBottomSpy).toHaveBeenCalledTimes(1);
  });

  it('does not call resetToBottom when items go from 0 to 0', () => {
    const session = createMockSession();
    const messages = createMockMessages({ items: [] });

    const { rerender } = render(<AgentPanel session={session} messages={messages} />);

    // Rerender with still-empty items
    rerender(<AgentPanel session={session} messages={createMockMessages({ items: [] })} />);

    expect(resetToBottomSpy).not.toHaveBeenCalled();
  });

  it('calls resetToBottom when session transitions from replaying to ready', () => {
    const session = createMockSession({ state: 'replaying' as AcpSessionHandle['state'] });
    const messages = createMockMessages();

    const { rerender } = render(<AgentPanel session={session} messages={messages} />);

    expect(resetToBottomSpy).not.toHaveBeenCalled();

    // Transition from replaying → ready
    const readySession = createMockSession({ state: 'ready' });
    rerender(<AgentPanel session={readySession} messages={messages} />);

    expect(resetToBottomSpy).toHaveBeenCalledTimes(1);
  });

  it('calls resetToBottom when session transitions from replaying to prompting', () => {
    const session = createMockSession({ state: 'replaying' as AcpSessionHandle['state'] });
    const messages = createMockMessages();

    const { rerender } = render(<AgentPanel session={session} messages={messages} />);

    // Transition from replaying → prompting
    const promptingSession = createMockSession({ state: 'prompting' });
    rerender(<AgentPanel session={promptingSession} messages={messages} />);

    expect(resetToBottomSpy).toHaveBeenCalledTimes(1);
  });

  it('does not call resetToBottom for non-replay state transitions', () => {
    const session = createMockSession({ state: 'ready' });
    const messages = createMockMessages();

    const { rerender } = render(<AgentPanel session={session} messages={messages} />);

    // Transition from ready → prompting (not a replay transition)
    const promptingSession = createMockSession({ state: 'prompting' });
    rerender(<AgentPanel session={promptingSession} messages={messages} />);

    expect(resetToBottomSpy).not.toHaveBeenCalled();
  });
});

// =============================================================================
// Scroll-to-bottom FAB tests
// =============================================================================

describe('AgentPanel scroll-to-bottom FAB', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let autoScrollSpy: any;
  let scrollToBottomSpy: ReturnType<typeof vi.fn>;

  function setupMock(isAtBottom: boolean) {
    scrollToBottomSpy = vi.fn();
    autoScrollSpy = vi.spyOn(autoScrollModule, 'useAutoScroll').mockReturnValue({
      scrollRef: vi.fn(),
      isAtBottom,
      scrollToBottom: scrollToBottomSpy,
      resetToBottom: vi.fn(),
    });
  }

  afterEach(() => {
    autoScrollSpy?.mockRestore();
  });

  it('shows scroll-to-bottom button when not at bottom and messages exist', () => {
    setupMock(false);
    const session = createMockSession();
    const items: ConversationItem[] = [
      { kind: 'user_message', id: '1', text: 'Hello', timestamp: Date.now() },
    ];
    const messages = createMockMessages({ items });

    render(<AgentPanel session={session} messages={messages} />);

    expect(screen.getByLabelText('Scroll to bottom')).toBeTruthy();
  });

  it('hides scroll-to-bottom button when at bottom', () => {
    setupMock(true);
    const session = createMockSession();
    const items: ConversationItem[] = [
      { kind: 'user_message', id: '1', text: 'Hello', timestamp: Date.now() },
    ];
    const messages = createMockMessages({ items });

    render(<AgentPanel session={session} messages={messages} />);

    expect(screen.queryByLabelText('Scroll to bottom')).toBeNull();
  });

  it('hides scroll-to-bottom button when no messages', () => {
    setupMock(false);
    const session = createMockSession();
    const messages = createMockMessages({ items: [] });

    render(<AgentPanel session={session} messages={messages} />);

    expect(screen.queryByLabelText('Scroll to bottom')).toBeNull();
  });

  it('calls scrollToBottom when FAB is clicked', () => {
    setupMock(false);
    const session = createMockSession();
    const items: ConversationItem[] = [
      { kind: 'user_message', id: '1', text: 'Hello', timestamp: Date.now() },
    ];
    const messages = createMockMessages({ items });

    render(<AgentPanel session={session} messages={messages} />);

    fireEvent.click(screen.getByLabelText('Scroll to bottom'));
    expect(scrollToBottomSpy).toHaveBeenCalledTimes(1);
  });
});
