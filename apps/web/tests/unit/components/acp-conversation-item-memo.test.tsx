import type { ConversationItem } from '@simple-agent-manager/acp-client';
import { render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Counts every react-markdown parse. `MessageBubble` renders agent text through
 * react-markdown + remark-gfm, so this counter is a direct measurement of the
 * work item #10 exists to eliminate: an unstable `onPlayAudio` identity defeats
 * `React.memo` on MessageBubble, and every settled bubble re-parses its markdown
 * on every streaming token.
 */
const markdownRenders = vi.fn();

vi.mock('react-markdown', () => ({
  default: ({ children }: { children?: ReactNode }) => {
    markdownRenders();
    return <div data-testid="markdown">{children}</div>;
  },
}));

vi.mock('../../../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getTtsApiUrl: () => 'https://api.example.test/tts',
}));

const startPlayback = vi.fn();
vi.mock('../../../src/contexts/GlobalAudioContext', () => ({
  useGlobalAudio: () => ({ startPlayback }),
}));

// Imported after the mocks so the mocked modules are in place.
const { AcpConversationItemView } = await import(
  '../../../src/components/project-message-view/AcpConversationItemView'
);

// `timestamp` must be a positive number — MessageBubble gates its action row
// (which hosts the "Read aloud" control) on `!streaming && timestamp > 0`.
function agentItem(id: string, text: string, streaming = false): ConversationItem {
  return {
    kind: 'agent_message',
    id,
    text,
    streaming,
    timestamp: 1_787_000_000_000,
  } as ConversationItem;
}

/**
 * Mirrors the real conversation list: settled bubbles above, one streaming at
 * the tail. `onFileClick` mirrors the production wiring in
 * `project-message-view/index.tsx` — for an active session it passes
 * `lc.handleFileClick`, which is `useCallback(fn, [])` in `useSessionLifecycle`
 * and therefore stable. Passing a stable function here (rather than leaving it
 * undefined) keeps the test honest about the real prop set: if that callback
 * ever stops being stable, MessageBubble's memo AND its internal
 * `agentComponents` useMemo both break, and these counts would move.
 */
const STABLE_FILE_CLICK = () => {};

function Conversation({
  items,
  onFileClick,
}: {
  items: ConversationItem[];
  onFileClick?: (path: string, line?: number | null) => void;
}) {
  return (
    <>
      {items.map((item) => (
        <AcpConversationItemView key={item.id} item={item} onFileClick={onFileClick} />
      ))}
    </>
  );
}

describe('AcpConversationItemView — MessageBubble memoization during streaming', () => {
  beforeEach(() => {
    markdownRenders.mockClear();
    startPlayback.mockClear();
  });

  it('does not re-parse settled bubbles when the streaming bubble receives a token', () => {
    const settled = [
      agentItem('a', 'first settled answer'),
      agentItem('b', 'second settled answer'),
      agentItem('c', 'third settled answer'),
    ];

    const { rerender } = render(
      <Conversation items={[...settled, agentItem('live', 'Hel', true)]} />
    );

    // 3 settled + 1 streaming on first paint.
    expect(markdownRenders).toHaveBeenCalledTimes(4);
    markdownRenders.mockClear();

    // A text_delta arrives: only the streaming item's `text` changed. The settled
    // items are referentially identical objects, exactly as the reducer produces.
    rerender(<Conversation items={[...settled, agentItem('live', 'Hello', true)]} />);

    // Pre-fix this was 4 (every bubble re-parsed). Post-fix only the streaming
    // bubble re-renders, because its own `text` prop genuinely changed.
    expect(markdownRenders).toHaveBeenCalledTimes(1);
  });

  it('keeps settled bubbles memoized across many consecutive tokens', () => {
    const settled = Array.from({ length: 8 }, (_, i) => agentItem(`s${i}`, `settled ${i}`));
    const stream = (text: string) => <Conversation items={[...settled, agentItem('live', text, true)]} />;

    const { rerender } = render(stream(''));
    markdownRenders.mockClear();

    const tokens = ['T', 'To', 'Tok', 'Toke', 'Token'];
    for (const token of tokens) rerender(stream(token));

    // Exactly one parse per token — the streaming bubble only. Pre-fix this was
    // tokens.length * (settled.length + 1) = 45.
    expect(markdownRenders).toHaveBeenCalledTimes(tokens.length);
  });

  it('stays memoized with the active-session onFileClick wiring', () => {
    // The production active-session path passes a real `onFileClick`, which also
    // feeds MessageBubble's `agentComponents` useMemo. Same expectation.
    const settled = [agentItem('a', 'first settled'), agentItem('b', 'second settled')];
    const stream = (text: string) => (
      <Conversation
        items={[...settled, agentItem('live', text, true)]}
        onFileClick={STABLE_FILE_CLICK}
      />
    );

    const { rerender } = render(stream('A'));
    markdownRenders.mockClear();

    rerender(stream('AB'));
    expect(markdownRenders).toHaveBeenCalledTimes(1);
  });

  it('still plays the correct audio for a settled bubble after memoization', () => {
    // Memoizing the handler must not staple a stale closure onto the bubble.
    const { getByLabelText, rerender } = render(
      <Conversation items={[agentItem('a', 'original text')]} />
    );
    rerender(<Conversation items={[agentItem('a', 'updated text')]} />);

    getByLabelText('Read aloud').click();

    expect(startPlayback).toHaveBeenCalledTimes(1);
    expect(startPlayback.mock.calls[0][0]).toMatchObject({
      text: 'updated text',
      ttsStorageId: 'a',
    });
  });
});
