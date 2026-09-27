import { act, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { Dialog } from '../src/components/Dialog';

/**
 * A modal must survive its parent re-rendering.
 *
 * Every caller in the app passes an inline `onClose={() => setOpen(false)}` arrow,
 * so `onClose` is a fresh function on each of the parent's renders. Project chat
 * re-renders constantly (ProjectData WebSocket session events, session-sync polls).
 * When `useModalInteraction` listed `onEscape` in its dep array, each of those
 * renders tore the effect down and back up — the teardown restores focus to the
 * opener and the setup focuses the dialog shell, so the field being typed into was
 * blurred. On a phone a blur closes the software keyboard, which made the agent
 * profile dialog unusable.
 *
 * These tests drive the real trigger (a parent render with an inline arrow), never
 * hand the dialog a stable callback it would not get in production, and pair every
 * "focus was not lost" assertion with a liveness assertion.
 */
function ChatLikeParent({ tick, onEscape }: { tick: number; onEscape?: () => void }) {
  const [text, setText] = useState('');
  return (
    <div>
      <span data-testid="tick">{tick}</span>
      <button type="button" data-testid="opener">
        Edit profile
      </button>
      {/* Inline arrow — exactly what ChatInput.tsx, ProfileList.tsx et al. pass. */}
      <Dialog
        isOpen
        onClose={() => {
          onEscape?.();
        }}
      >
        <input
          data-testid="name"
          value={text}
          onChange={(event) => setText(event.currentTarget.value)}
        />
      </Dialog>
    </div>
  );
}

describe('Dialog focus stability across parent re-renders', () => {
  it('keeps focus and typed text on the field when the parent re-renders', () => {
    const { rerender } = render(<ChatLikeParent tick={0} />);
    const input = screen.getByTestId('name') as HTMLInputElement;

    act(() => input.focus());
    fireEvent.change(input, { target: { value: 'My Renamed Profile' } });
    expect(document.activeElement).toBe(input);

    // Three ordinary parent re-renders. No prop the dialog cares about changed —
    // this is a websocket session event landing while the modal is open.
    for (const tick of [1, 2, 3]) {
      rerender(<ChatLikeParent tick={tick} />);
    }

    // Liveness: the dialog is still mounted and still holds the user's text, so a
    // pass here cannot mean the subtree quietly disappeared.
    expect(screen.getByTestId('tick')).toHaveTextContent('3');
    expect(input).toBeInTheDocument();
    expect(input.value).toBe('My Renamed Profile');

    expect(document.activeElement).toBe(input);
  });

  it('still closes on Escape after the parent has re-rendered', () => {
    const onEscape = vi.fn();
    const { rerender } = render(<ChatLikeParent tick={0} onEscape={onEscape} />);

    rerender(<ChatLikeParent tick={1} onEscape={onEscape} />);
    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onEscape).toHaveBeenCalledTimes(1);
  });

  it('calls the LATEST onEscape, not the one captured when the modal opened', () => {
    const first = vi.fn();
    const second = vi.fn();

    const { rerender } = render(<ChatLikeParent tick={0} onEscape={first} />);
    rerender(<ChatLikeParent tick={1} onEscape={second} />);
    fireEvent.keyDown(document, { key: 'Escape' });

    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
  });
});
