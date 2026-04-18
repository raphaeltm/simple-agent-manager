/**
 * ChatGate — suggestion chips + chat input for the trial discovery flow.
 *
 * Rendered inside {@link TryDiscovery} once the `trial.ready` SSE event has
 * fired. Authenticated visitors submit directly to the project's normal chat
 * endpoint; anonymous visitors hit the {@link LoginSheet} first. After
 * sign-in, the draft (persisted by {@link useTrialDraft}) survives the OAuth
 * round-trip and is replayed by {@link useTrialClaim}.
 *
 * Layout:
 *   ┌──────────────────────────────────────────────┐
 *   │ [chip] [chip] [chip] ...          (scrolls)  │
 *   ├──────────────────────────────────────────────┤
 *   │ ┌────────────────────────────────┐ ┌───┐     │
 *   │ │ textarea                        │ │ → │     │
 *   │ └────────────────────────────────┘ └───┘     │
 *   └──────────────────────────────────────────────┘
 */
import type { TrialIdea } from '@simple-agent-manager/shared';
import { useCallback, useRef, useState } from 'react';

import { useTrialDraft } from '../../hooks/useTrialDraft';
import { useAuth } from '../AuthProvider';
import { LoginSheet } from './LoginSheet';
import { SuggestionChip } from './SuggestionChip';

interface ChatGateProps {
  trialId: string;
  ideas: TrialIdea[];
  /**
   * Called when an authenticated visitor sends a message. The caller is
   * responsible for routing the message to the correct project chat endpoint
   * (since the project ID is known only to {@link TryDiscovery}).
   *
   * Must return a promise that resolves on successful submit — the draft is
   * cleared after the promise resolves so failed sends don't lose the user's
   * text.
   */
  onAuthenticatedSubmit: (message: string) => Promise<void>;
  /** Optional textarea placeholder. */
  placeholder?: string;
  /** Injected for testing — defaults to false unless tests force it. */
  forceAnonymous?: boolean;
}

export function ChatGate({
  trialId,
  ideas,
  onAuthenticatedSubmit,
  placeholder = 'Ask anything about this repo…',
  forceAnonymous = false,
}: ChatGateProps) {
  const { isAuthenticated } = useAuth();
  const { draft, setDraft, clearDraft } = useTrialDraft(trialId);
  const [showLogin, setShowLogin] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const treatAsAuthenticated = isAuthenticated && !forceAnonymous;

  const handleChipSelect = useCallback(
    (idea: TrialIdea) => {
      setDraft(idea.prompt);
      setErrorMessage(null);
      // Focus textarea so the user can immediately edit or press Send.
      textareaRef.current?.focus();
    },
    [setDraft],
  );

  const handleSend = useCallback(async () => {
    const trimmed = draft.trim();
    if (!trimmed || isSending) return;

    if (!treatAsAuthenticated) {
      setShowLogin(true);
      return;
    }

    setIsSending(true);
    setErrorMessage(null);
    try {
      await onAuthenticatedSubmit(trimmed);
      clearDraft();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to send message';
      setErrorMessage(message);
    } finally {
      setIsSending(false);
    }
  }, [draft, isSending, treatAsAuthenticated, onAuthenticatedSubmit, clearDraft]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // Cmd/Ctrl+Enter submits; plain Enter inserts a newline (matches the
      // rest of the product's chat inputs).
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        void handleSend();
      }
    },
    [handleSend],
  );

  const canSend = draft.trim().length > 0 && !isSending;

  return (
    <section
      aria-label="Try SAM — chat gate"
      className="w-full max-w-3xl mx-auto flex flex-col gap-3"
      data-testid="trial-chat-gate"
    >
      {ideas.length > 0 && (
        <div
          className="flex gap-2 overflow-x-auto pb-1 -mx-4 px-4 md:mx-0 md:px-0 scrollbar-thin"
          role="list"
          aria-label="Suggested prompts"
          data-testid="trial-chat-gate-chips"
        >
          {ideas.map((idea) => (
            <div role="listitem" key={idea.id}>
              <SuggestionChip idea={idea} onSelect={handleChipSelect} disabled={isSending} />
            </div>
          ))}
        </div>
      )}

      <div className="flex items-end gap-2">
        <label htmlFor="trial-chat-input" className="sr-only">
          Message
        </label>
        <textarea
          ref={textareaRef}
          id="trial-chat-input"
          data-testid="trial-chat-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          rows={3}
          disabled={isSending}
          aria-describedby={errorMessage ? 'trial-chat-error' : undefined}
          className="
            flex-1 resize-none min-h-14 rounded-lg
            border border-border-default bg-inset text-fg-primary
            px-3 py-2 text-sm
            focus:outline-none focus:ring-2 focus:ring-accent
            disabled:opacity-60
          "
        />
        <button
          type="button"
          onClick={() => void handleSend()}
          disabled={!canSend}
          data-testid="trial-chat-send"
          aria-label="Send message"
          className="
            inline-flex items-center justify-center
            min-h-14 min-w-14 rounded-lg
            bg-accent text-fg-on-accent font-semibold
            hover:bg-accent-hover
            focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent
            disabled:opacity-40 disabled:cursor-not-allowed
            transition-colors
          "
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
              d="M4 12l16-8-6 16-3-7-7-1z"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              fill="currentColor"
            />
          </svg>
        </button>
      </div>

      {errorMessage && (
        <p
          id="trial-chat-error"
          role="alert"
          data-testid="trial-chat-error"
          className="text-xs text-danger"
        >
          {errorMessage}
        </p>
      )}

      <LoginSheet
        isOpen={showLogin}
        onClose={() => setShowLogin(false)}
        trialId={trialId}
      />
    </section>
  );
}
