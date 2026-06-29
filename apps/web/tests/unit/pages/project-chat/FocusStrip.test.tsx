/**
 * Behavioral tests for the Focus Mode session strip (64px collapsed sidebar).
 *
 * The most important invariant is the tooltip-portal one (research finding #5):
 * the session peek tooltip MUST be parented to `document.body` via createPortal,
 * not rendered inline inside the strip. The sidebar's glass ancestors apply
 * `contain: paint` / `transform`, which clip and mis-stack a normally-positioned
 * tooltip. Parenting to <body> escapes both. These tests render FocusStrip,
 * hover/focus a session status icon, and assert the rendered tooltip's parent
 * is <body>.
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { ChatSessionListItem } from '../../../../src/lib/api';
import { FocusStrip } from '../../../../src/pages/project-chat/FocusStrip';
import type { TaskInfo } from '../../../../src/pages/project-chat/useTaskGroups';

const SESSION_DEFAULTS: ChatSessionListItem = {
  id: 'sess-1',
  workspaceId: null,
  taskId: null,
  topic: 'Implement authentication flow',
  status: 'active',
  messageCount: 5,
  startedAt: Date.now() - 60_000,
  endedAt: null,
  createdAt: Date.now() - 60_000,
  lastMessageAt: Date.now(),
  isIdle: false,
  agentCompletedAt: null,
};

function makeSession(overrides: Partial<ChatSessionListItem> = {}): ChatSessionListItem {
  return { ...SESSION_DEFAULTS, ...overrides };
}

const SESSIONS = [
  makeSession({ id: 'sess-1', topic: 'Implement authentication flow' }),
  makeSession({ id: 'sess-2', topic: 'Refactor credential resolution', status: 'stopped' }),
];

function renderStrip(props: Partial<React.ComponentProps<typeof FocusStrip>> = {}) {
  return render(
    <FocusStrip
      sessions={SESSIONS}
      selectedSessionId={null}
      onSelect={vi.fn()}
      taskInfoMap={new Map<string, TaskInfo>()}
      onNewChat={vi.fn()}
      {...props}
    />,
  );
}

describe('FocusStrip', () => {
  it('renders a status-icon button per session plus a New chat button', () => {
    renderStrip();
    expect(screen.getByRole('button', { name: 'New chat' })).toBeInTheDocument();
    // aria-label is `${topic} — ${attentionLabel}` (label suffix varies).
    expect(
      screen.getByRole('button', { name: /^Implement authentication flow — / }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /^Refactor credential resolution — / }),
    ).toBeInTheDocument();
  });

  it('calls onNewChat when the New chat button is clicked', () => {
    const onNewChat = vi.fn();
    renderStrip({ onNewChat });
    fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
    expect(onNewChat).toHaveBeenCalledTimes(1);
  });

  it('calls onSelect with the session id when a status icon is clicked', () => {
    const onSelect = vi.fn();
    renderStrip({ onSelect });
    fireEvent.click(screen.getByRole('button', { name: /^Implement authentication flow — / }));
    expect(onSelect).toHaveBeenCalledWith('sess-1');
  });

  it('peeks a tooltip on hover that is portaled to document.body (escapes glass clipping)', () => {
    renderStrip();
    expect(screen.queryByTestId('focus-tooltip')).not.toBeInTheDocument();

    fireEvent.mouseEnter(
      screen.getByRole('button', { name: /^Implement authentication flow — / }),
    );

    const tooltip = screen.getByTestId('focus-tooltip');
    expect(tooltip).toHaveAttribute('role', 'tooltip');
    // The critical invariant: the tooltip is a direct child of <body>, not
    // nested inside the FocusStrip's (glass-clipped) DOM subtree.
    expect(tooltip.parentElement).toBe(document.body);
    // WCAG 1.3.1 / ARIA tooltip pattern: the tooltip must be programmatically
    // associated with its trigger via id + aria-describedby.
    expect(tooltip).toHaveAttribute('id', 'focus-strip-tooltip');
    expect(
      screen.getByRole('button', { name: /^Implement authentication flow — / }),
    ).toHaveAttribute('aria-describedby', 'focus-strip-tooltip');
  });

  it('also peeks the tooltip on keyboard focus (parented to body)', () => {
    renderStrip();
    fireEvent.focus(screen.getByRole('button', { name: /^Refactor credential resolution — / }));
    const tooltip = screen.getByTestId('focus-tooltip');
    expect(tooltip.parentElement).toBe(document.body);
  });

  it('closes the tooltip after blur (close delay elapsed)', () => {
    vi.useFakeTimers();
    try {
      renderStrip();
      const icon = screen.getByRole('button', { name: /^Implement authentication flow — / });
      fireEvent.focus(icon);
      expect(screen.getByTestId('focus-tooltip')).toBeInTheDocument();
      fireEvent.blur(icon);
      act(() => {
        vi.advanceTimersByTime(200);
      });
      expect(screen.queryByTestId('focus-tooltip')).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});
