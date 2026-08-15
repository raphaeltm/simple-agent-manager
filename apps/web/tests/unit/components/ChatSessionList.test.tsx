import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { ChatSessionList } from '../../../src/components/ChatSessionList';
import type { ChatSessionListItem } from '../../../src/lib/api';

function makeSession(overrides: Partial<ChatSessionListItem> = {}): ChatSessionListItem {
  return {
    id: 'sess-1',
    workspaceId: null,
    taskId: null,
    topic: 'Fix the bug',
    status: 'active',
    messageCount: 3,
    startedAt: 1000,
    endedAt: null,
    createdAt: 1000,
    ...overrides,
  };
}

describe('ChatSessionList', () => {
  it('renders an empty state when there are no sessions', () => {
    render(<ChatSessionList sessions={[]} onSelect={vi.fn()} />);
    expect(screen.getByText('No sessions yet')).toBeInTheDocument();
  });

  it('renders each session as a row with its topic and message count', () => {
    render(
      <ChatSessionList
        sessions={[makeSession({ id: 's-1', topic: 'Fix the bug', messageCount: 3 })]}
        onSelect={vi.fn()}
      />
    );

    expect(screen.getByText('Fix the bug')).toBeInTheDocument();
    expect(screen.getByText('3 messages')).toBeInTheDocument();
  });

  it('calls onSelect with the session id on click', () => {
    const onSelect = vi.fn();
    render(<ChatSessionList sessions={[makeSession({ id: 'sess-42' })]} onSelect={onSelect} />);

    fireEvent.click(screen.getByRole('button', { name: /Fix the bug/ }));

    expect(onSelect).toHaveBeenCalledWith('sess-42');
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  // Each row is a real <button> (not a <li> with a synthetic role="button"),
  // so Enter/Space activation is native browser behavior rather than
  // hand-rolled JS. jsdom does not simulate that default action for a bare
  // fireEvent.keyDown, so userEvent.keyboard() (which does simulate it) is
  // the correct way to prove the keyboard path actually works — see
  // .claude/rules/02-quality-gates.md interactive-element test requirement.
  it('calls onSelect when the row is activated with Enter from the keyboard', async () => {
    const onSelect = vi.fn();
    render(<ChatSessionList sessions={[makeSession({ id: 'sess-enter' })]} onSelect={onSelect} />);

    const row = screen.getByRole('button', { name: /Fix the bug/ });
    row.focus();
    await userEvent.keyboard('{Enter}');

    expect(onSelect).toHaveBeenCalledWith('sess-enter');
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('calls onSelect when the row is activated with Space from the keyboard', async () => {
    const onSelect = vi.fn();
    render(<ChatSessionList sessions={[makeSession({ id: 'sess-space' })]} onSelect={onSelect} />);

    const row = screen.getByRole('button', { name: /Fix the bug/ });
    row.focus();
    await userEvent.keyboard(' ');

    expect(onSelect).toHaveBeenCalledWith('sess-space');
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('renders multiple sessions as separately focusable, independently selectable rows', () => {
    const onSelect = vi.fn();
    render(
      <ChatSessionList
        sessions={[
          makeSession({ id: 's-1', topic: 'First session' }),
          makeSession({ id: 's-2', topic: 'Second session' }),
        ]}
        onSelect={onSelect}
      />
    );

    const rows = screen.getAllByRole('button');
    expect(rows).toHaveLength(2);

    fireEvent.click(screen.getByRole('button', { name: /Second session/ }));
    expect(onSelect).toHaveBeenCalledWith('s-2');
    expect(onSelect).not.toHaveBeenCalledWith('s-1');
  });
});
