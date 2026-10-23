/**
 * PROTOTYPE (dev-only route `/prototype/comment-context`): three ways to read a comment in the
 * context of the agent conversation it is about, guaranteed to open on the commented passage,
 * with room to scroll or expand backwards and forwards through the discussion.
 *
 *   A · Reader + thread  — conversation as the main surface, thread beside it or in a sheet
 *   B · Thread inline    — the thread drawn under its message, inside the conversation
 *   C · Expand around    — the commented message alone, context revealed on request
 *
 * Mock data only, no API calls, no auth. Remove before merging to main
 * (.claude/rules/37-prototype-development.md).
 *
 * URL parameters: `?v=a|b|c`, `?t=<thread id>`, `?sheet=open` (A on a phone), `?clean=1`
 * hides the direction switcher for screenshots.
 */
import { useCallback, useMemo, useState } from 'react';

import { useMediaQuery } from '../../hooks/useMediaQuery';
import { AppFrame } from '../comments-inbox-prototype/frame';
import { type CommentNav, type Direction, DirectionSwitcher } from './chrome';
import { DirectionA } from './direction-a';
import { DirectionB } from './direction-b';
import { DirectionC } from './direction-c';
import { SESSIONS, THREADS, WEBHOOK_CHAT } from './mock-session';
import { QUOTE_HIGHLIGHT_CSS } from './quote-highlight';
import { useThreadState } from './thread-view';

function readParams() {
  const params = new URLSearchParams(window.location.search);
  const v = params.get('v');
  return {
    direction: (v === 'b' || v === 'c' ? v : 'a') as Direction,
    threadId: params.get('t') ?? THREADS[0]?.id ?? '',
    sheetOpen: params.get('sheet') === 'open',
    clean: params.get('clean') === '1',
  };
}

export function CommentContextPrototype() {
  const initial = useMemo(readParams, []);
  const wide = useMediaQuery('(min-width: 1024px)');
  const [direction, setDirection] = useState<Direction>(initial.direction);
  const [activeId, setActiveId] = useState(initial.threadId);
  const { threads, reply, toggleResolved } = useThreadState(THREADS);

  const index = Math.max(
    0,
    threads.findIndex((thread) => thread.id === activeId)
  );
  const thread = threads[index] ?? threads[0];
  const session = (thread && SESSIONS[thread.sessionId]) ?? WEBHOOK_CHAT;
  const select = useCallback((id: string) => setActiveId(id), []);
  const previous = threads[index - 1];
  const next = threads[index + 1];
  const nav: CommentNav = {
    position: index + 1,
    total: threads.length,
    onPrev: previous ? () => setActiveId(previous.id) : undefined,
    onNext: next ? () => setActiveId(next.id) : undefined,
  };
  if (!thread) return null;

  const props = {
    wide,
    session,
    threads,
    thread,
    nav,
    onSelectThread: select,
    onReply: reply,
    onToggleResolved: toggleResolved,
    onBack: () => {
      window.location.href = '/prototype/comments-inbox';
    },
    sheetOpen: initial.sheetOpen,
  };
  const body =
    direction === 'a' ? (
      <DirectionA key={`a-${wide}`} {...props} />
    ) : direction === 'b' ? (
      <DirectionB key={`b-${wide}`} {...props} />
    ) : (
      <DirectionC key={`c-${wide}`} {...props} />
    );
  const switcher = initial.clean ? null : (
    <DirectionSwitcher value={direction} onChange={setDirection} />
  );

  return (
    <div data-testid="comment-context-prototype-page">
      <style>{QUOTE_HIGHLIGHT_CSS}</style>
      {wide ? (
        <AppFrame
          wide
          needsYou={threads.filter((candidate) => candidate.needsYou).length}
          scroll={false}
        >
          {switcher}
          {body}
        </AppFrame>
      ) : (
        <div className="flex flex-col bg-canvas" style={{ height: '100dvh' }}>
          {switcher}
          <div className="relative min-h-0 flex-1">{body}</div>
        </div>
      )}
    </div>
  );
}
