import type { TrialIdea } from '@simple-agent-manager/shared';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ChatGate } from '../../../../src/components/trial/ChatGate';
import { TRIAL_DRAFT_STORAGE_PREFIX } from '../../../../src/hooks/useTrialDraft';

let mockIsAuthenticated = true;

vi.mock('../../../../src/components/AuthProvider', () => ({
  useAuth: () => ({ isAuthenticated: mockIsAuthenticated }),
}));
vi.mock('../../../../src/hooks/useIsMobile', () => ({
  useIsMobile: () => false,
}));

const ideas: TrialIdea[] = [
  { id: 'i1', title: 'Idea One', summary: 'Summary one', prompt: 'Prompt one' },
  { id: 'i2', title: 'Idea Two', summary: 'Summary two', prompt: 'Prompt two' },
];

describe('ChatGate', () => {
  beforeEach(() => {
    mockIsAuthenticated = true;
    window.localStorage.clear();
  });

  afterEach(() => {
    window.localStorage.clear();
  });

  it('renders all supplied suggestion chips', () => {
    render(
      <ChatGate trialId="trial-1" ideas={ideas} onAuthenticatedSubmit={vi.fn()} />,
    );
    expect(screen.getByTestId('suggestion-chip-i1')).toBeInTheDocument();
    expect(screen.getByTestId('suggestion-chip-i2')).toBeInTheDocument();
  });

  it('fills the textarea when a suggestion chip is clicked', () => {
    render(
      <ChatGate trialId="trial-1" ideas={ideas} onAuthenticatedSubmit={vi.fn()} />,
    );
    fireEvent.click(screen.getByTestId('suggestion-chip-i1'));
    const textarea = screen.getByTestId('trial-chat-input') as HTMLTextAreaElement;
    expect(textarea.value).toBe('Prompt one');
  });

  it('opens the LoginSheet when anonymous user presses Send', () => {
    render(
      <ChatGate
        trialId="trial-1"
        ideas={ideas}
        onAuthenticatedSubmit={vi.fn()}
        forceAnonymous
      />,
    );

    // Type something then click send
    const textarea = screen.getByTestId('trial-chat-input');
    fireEvent.change(textarea, { target: { value: 'hi there' } });
    fireEvent.click(screen.getByTestId('trial-chat-send'));

    expect(screen.getByTestId('trial-login-sheet')).toBeInTheDocument();
  });

  it('disables send when the textarea is empty or whitespace-only', () => {
    render(
      <ChatGate trialId="trial-1" ideas={ideas} onAuthenticatedSubmit={vi.fn()} />,
    );
    const send = screen.getByTestId('trial-chat-send');
    expect(send).toBeDisabled();

    fireEvent.change(screen.getByTestId('trial-chat-input'), {
      target: { value: '   \n  ' },
    });
    expect(send).toBeDisabled();
  });

  it('submits the trimmed draft via onAuthenticatedSubmit when authenticated', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <ChatGate trialId="trial-1" ideas={ideas} onAuthenticatedSubmit={onSubmit} />,
    );

    fireEvent.change(screen.getByTestId('trial-chat-input'), {
      target: { value: '   hello world   ' },
    });
    fireEvent.click(screen.getByTestId('trial-chat-send'));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith('hello world');
  });

  it('clears the draft after successful send', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <ChatGate trialId="trial-1" ideas={ideas} onAuthenticatedSubmit={onSubmit} />,
    );

    fireEvent.change(screen.getByTestId('trial-chat-input'), {
      target: { value: 'send this' },
    });
    fireEvent.click(screen.getByTestId('trial-chat-send'));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());

    const textarea = screen.getByTestId('trial-chat-input') as HTMLTextAreaElement;
    await waitFor(() => expect(textarea.value).toBe(''));
  });

  it('preserves draft and surfaces error when send fails', async () => {
    const onSubmit = vi.fn().mockRejectedValue(new Error('rate limited'));
    render(
      <ChatGate trialId="trial-1" ideas={ideas} onAuthenticatedSubmit={onSubmit} />,
    );

    fireEvent.change(screen.getByTestId('trial-chat-input'), {
      target: { value: 'will fail' },
    });
    fireEvent.click(screen.getByTestId('trial-chat-send'));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('rate limited'));
    const textarea = screen.getByTestId('trial-chat-input') as HTMLTextAreaElement;
    expect(textarea.value).toBe('will fail');
  });

  it('Cmd+Enter submits; plain Enter inserts a newline', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <ChatGate trialId="trial-1" ideas={ideas} onAuthenticatedSubmit={onSubmit} />,
    );

    const textarea = screen.getByTestId('trial-chat-input');
    fireEvent.change(textarea, { target: { value: 'quick send' } });

    // Plain Enter — no submit
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(onSubmit).not.toHaveBeenCalled();

    // Cmd+Enter — submits
    fireEvent.keyDown(textarea, { key: 'Enter', metaKey: true });
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith('quick send'));
  });

  it('shows the spinner and disables the textarea while send is in-flight', async () => {
    let resolveSubmit: (() => void) | undefined;
    const onSubmit = vi.fn().mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveSubmit = resolve;
        }),
    );
    render(
      <ChatGate trialId="trial-1" ideas={ideas} onAuthenticatedSubmit={onSubmit} />,
    );

    const textarea = screen.getByTestId('trial-chat-input') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'pending send' } });

    // Idle state: no spinner.
    expect(screen.queryByTestId('trial-chat-send-spinner')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('trial-chat-send'));

    // Sending state: spinner visible, textarea disabled, button aria-busy.
    await waitFor(() =>
      expect(screen.getByTestId('trial-chat-send-spinner')).toBeInTheDocument(),
    );
    expect(textarea).toBeDisabled();
    expect(screen.getByTestId('trial-chat-send')).toHaveAttribute('aria-busy', 'true');

    // Resolve the in-flight send and observe the spinner disappear.
    resolveSubmit?.();
    await waitFor(() =>
      expect(screen.queryByTestId('trial-chat-send-spinner')).not.toBeInTheDocument(),
    );
    expect(textarea).not.toBeDisabled();
  });

  it('draft persists across unmount/remount via localStorage', () => {
    const { unmount } = render(
      <ChatGate trialId="trial-1" ideas={ideas} onAuthenticatedSubmit={vi.fn()} />,
    );
    // Simulate persisted draft being present — bypasses the debounce
    window.localStorage.setItem(
      `${TRIAL_DRAFT_STORAGE_PREFIX}trial-1`,
      'typed but not sent',
    );
    unmount();

    render(
      <ChatGate trialId="trial-1" ideas={ideas} onAuthenticatedSubmit={vi.fn()} />,
    );
    const textarea = screen.getByTestId('trial-chat-input') as HTMLTextAreaElement;
    expect(textarea.value).toBe('typed but not sent');
  });
});
