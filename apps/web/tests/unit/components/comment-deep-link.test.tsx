import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';
import { describe, expect, it } from 'vitest';

import { useCommentDeepLink } from '../../../src/components/project-message-view/comments/useCommentDeepLink';

function Probe() {
  const link = useCommentDeepLink();
  const location = useLocation();
  return (
    <>
      <output data-testid="parsed">
        {JSON.stringify({ target: link.targetMessage, thread: link.focusThreadId })}
      </output>
      <output data-testid="url">{`${location.pathname}${location.search}${location.hash}`}</output>
      <button type="button" onClick={link.consume}>
        consume
      </button>
    </>
  );
}

function renderAt(url: string) {
  render(
    <MemoryRouter initialEntries={[url]}>
      <Probe />
    </MemoryRouter>
  );
}

describe('useCommentDeepLink', () => {
  it('reads the thread and message a comment notification links to', () => {
    renderAt('/projects/p1/chat/s1?commentThread=thread-7&commentMessage=msg-3');
    expect(JSON.parse(screen.getByTestId('parsed').textContent ?? '')).toEqual({
      target: { messageId: 'msg-3', timestamp: null },
      thread: 'thread-7',
    });
  });

  it('reads the message and time the project Comments page links to', () => {
    renderAt('/projects/p1/chat/s1?commentMessage=msg-3&commentAt=1700000000000');
    expect(JSON.parse(screen.getByTestId('parsed').textContent ?? '')).toEqual({
      target: { messageId: 'msg-3', timestamp: 1_700_000_000_000 },
      thread: null,
    });
  });

  it('drops only the comment parameters once consumed, so a refresh does not jump again', () => {
    renderAt(
      '/projects/p1/chat/s1?keep=1&commentThread=thread-7&commentMessage=msg-3&commentAt=5#hierarchy-t1'
    );
    fireEvent.click(screen.getByRole('button', { name: 'consume' }));
    expect(screen.getByTestId('url')).toHaveTextContent('/projects/p1/chat/s1?keep=1#hierarchy-t1');
    expect(JSON.parse(screen.getByTestId('parsed').textContent ?? '')).toEqual({
      target: null,
      thread: null,
    });
  });

  it('leaves an unrelated URL untouched', () => {
    renderAt('/projects/p1/chat/s1?keep=1');
    fireEvent.click(screen.getByRole('button', { name: 'consume' }));
    expect(screen.getByTestId('url')).toHaveTextContent('/projects/p1/chat/s1?keep=1');
  });
});
