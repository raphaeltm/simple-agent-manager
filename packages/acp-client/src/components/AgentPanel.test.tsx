import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AgentPanel, CLIENT_COMMANDS } from './AgentPanel';
import type { AcpSessionHandle } from '../hooks/useAcpSession';
import type { AcpMessagesHandle } from '../hooks/useAcpMessages';
import type { SlashCommand } from '../types';

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
