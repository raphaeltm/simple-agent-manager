import type { CommentMention } from '@simple-agent-manager/shared';
import { getMentionQuery } from '@simple-agent-manager/shared';
import {
  type KeyboardEvent,
  type RefObject,
  useCallback,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import {
  filterMentionCandidates,
  type MentionCandidate,
  retainedMentions,
} from './comment-mentions';

interface UseMemberMentionsOptions {
  /** Off for surfaces without people mentions (library files): the hook then does nothing. */
  enabled: boolean;
  candidates: readonly MentionCandidate[];
  /** The member list has not arrived yet. */
  loading: boolean;
  body: string;
  setBody: (next: string) => void;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
}

/**
 * @mention autocomplete state for one comment field.
 *
 * The token at the caret is found with the same `getMentionQuery` boundary the chat composer
 * uses for agent-profile mentions, so `@` only opens the palette at the start of a word.
 * Picking a member inserts `@Display Name ` and records the pick; `mentionsFor(body)` later
 * keeps only the picks whose text is still in the body. Nothing here is sent anywhere — the
 * composer submits what `mentionsFor` returns.
 */
export function useMemberMentions({
  enabled,
  candidates,
  loading,
  body,
  setBody,
  textareaRef,
}: UseMemberMentionsOptions) {
  const listboxId = useId();
  const [caret, setCaret] = useState(() => body.length);
  const [picked, setPicked] = useState<CommentMention[]>([]);
  // The `@` index the author dismissed with Escape: that token stays closed while it is
  // being typed, and a new `@` (or leaving the token) opens the palette again.
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  // Keyed by the token so the highlight returns to the top whenever the filter changes.
  const [active, setActive] = useState({ key: '', index: 0 });
  // The palette floats over the page, so it must not outlive the field's focus: tapping
  // elsewhere closes it. Picking an option keeps focus (the option cancels its mousedown).
  const [focused, setFocused] = useState(false);
  const pendingCaretRef = useRef<number | null>(null);

  const query = enabled ? getMentionQuery(body.slice(0, caret)) : null;
  const queryIndex = query?.index ?? null;
  const queryFilter = query?.filter ?? null;
  const tokenKey = queryIndex === null ? '' : `${queryIndex}:${queryFilter}`;
  const visible = focused && queryIndex !== null && queryIndex !== dismissedAt;

  const options = useMemo(
    () => (visible && queryFilter !== null ? filterMentionCandidates(candidates, queryFilter) : []),
    [candidates, queryFilter, visible]
  );
  const open = visible && (options.length > 0 || loading);
  const activeIndex = active.key === tokenKey && active.index < options.length ? active.index : 0;
  const optionId = useCallback((index: number) => `${listboxId}-option-${index}`, [listboxId]);

  /** Track the caret. Call from the field's change and select handlers. */
  const syncCaret = useCallback((textarea: HTMLTextAreaElement) => {
    const position = textarea.selectionStart ?? textarea.value.length;
    setCaret(position);
    const next = getMentionQuery(textarea.value.slice(0, position));
    setDismissedAt((current) =>
      current !== null && (!next || next.index !== current) ? null : current
    );
  }, []);

  const pick = useCallback(
    (index: number) => {
      const candidate = options[index];
      if (queryIndex === null || !candidate) return;
      const before = body.slice(0, queryIndex);
      const rest = body.slice(caret);
      const insertion = `@${candidate.label} `;
      const next = before + insertion + (rest.startsWith(' ') ? rest.slice(1) : rest);
      const nextCaret = before.length + insertion.length;
      pendingCaretRef.current = nextCaret;
      setBody(next);
      setCaret(nextCaret);
      setPicked((current) =>
        current.some((mention) => mention.userId === candidate.userId)
          ? current
          : [...current, { userId: candidate.userId, displayName: candidate.label }]
      );
    },
    [body, caret, options, queryIndex, setBody]
  );

  // Put the caret after the inserted name once React has written the new value.
  useLayoutEffect(() => {
    const nextCaret = pendingCaretRef.current;
    const textarea = textareaRef.current;
    if (nextCaret === null || !textarea) return;
    pendingCaretRef.current = null;
    textarea.focus();
    textarea.setSelectionRange(nextCaret, nextCaret);
  }, [body, textareaRef]);

  /** Delegate the field's keydown here first; returns true when the palette consumed it. */
  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
      if (!open || event.nativeEvent.isComposing) return false;
      const count = options.length;
      switch (event.key) {
        case 'ArrowDown':
        case 'ArrowUp': {
          if (count === 0) return false;
          event.preventDefault();
          event.stopPropagation();
          const step = event.key === 'ArrowDown' ? 1 : -1;
          setActive({ key: tokenKey, index: (activeIndex + step + count) % count });
          return true;
        }
        case 'Enter':
          if (count === 0 || event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) {
            return false;
          }
          event.preventDefault();
          event.stopPropagation();
          pick(activeIndex);
          return true;
        case 'Tab':
          if (count === 0 || event.shiftKey) return false;
          // Stopped too: a drawer's focus trap listens for Tab on window.
          event.preventDefault();
          event.stopPropagation();
          pick(activeIndex);
          return true;
        case 'Escape':
          // Close the palette only: not the composer, and not a drawer listening on window.
          event.preventDefault();
          event.stopPropagation();
          setDismissedAt(queryIndex);
          return true;
        default:
          return false;
      }
    },
    [activeIndex, open, options.length, pick, queryIndex, tokenKey]
  );

  const setActiveIndex = useCallback(
    (index: number) => setActive({ key: tokenKey, index }),
    [tokenKey]
  );

  /** The picks whose `@Name` is still in `text` — what a submit should send. */
  const mentionsFor = useCallback((text: string) => retainedMentions(text, picked), [picked]);

  const reset = useCallback(() => {
    setPicked([]);
    setDismissedAt(null);
    setCaret(0);
  }, []);

  const fieldProps = enabled
    ? {
        role: 'combobox' as const,
        'aria-autocomplete': 'list' as const,
        'aria-expanded': open,
        'aria-controls': open ? listboxId : undefined,
        'aria-activedescendant': open && options.length > 0 ? optionId(activeIndex) : undefined,
        onFocus: () => setFocused(true),
        onBlur: () => setFocused(false),
      }
    : {};

  return {
    open,
    options,
    activeIndex,
    listboxId,
    optionId,
    fieldProps,
    syncCaret,
    handleKeyDown,
    pick,
    setActiveIndex,
    mentionsFor,
    reset,
  };
}
