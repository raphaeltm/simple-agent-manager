import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ChatTimelineDrawer } from '../../../src/components/chat/ChatTimelineDrawer';
import type { TimelineEntry } from '../../../src/components/project-message-view/timeline-types';

function makeUserEntry(overrides: Partial<Extract<TimelineEntry, { kind: 'user_message' }>> = {}): TimelineEntry {
  return {
    kind: 'user_message',
    id: 'msg-1',
    messageId: 'm1',
    text: 'Hello world',
    timestamp: 1000,
    messageIndex: 0,
    ...overrides,
  };
}

function makeSystemEntry(overrides: Partial<Extract<TimelineEntry, { kind: 'system_event' }>> = {}): TimelineEntry {
  return {
    kind: 'system_event',
    id: 'evt-1',
    eventType: 'workspace.created',
    title: 'Workspace created',
    timestamp: 500,
    severity: 'info',
    ...overrides,
  };
}

function makeProgressEntry(overrides: Partial<Extract<TimelineEntry, { kind: 'progress_notification' }>> = {}): TimelineEntry {
  return {
    kind: 'progress_notification',
    id: 'notif-1',
    notificationId: 'n1',
    title: 'Progress: Build',
    text: 'Installed dependencies and started focused tests',
    timestamp: 750,
    severity: 'info',
    ...overrides,
  };
}

const defaultProps = {
  entries: [] as TimelineEntry[],
  loading: false,
  showContext: false,
  onToggleContext: vi.fn(),
  onClose: vi.fn(),
  onJumpToMessage: vi.fn(),
};

describe('ChatTimelineDrawer', () => {
  it('renders empty state when no entries and not loading', () => {
    render(<ChatTimelineDrawer {...defaultProps} />);
    expect(screen.getByText('No timeline entries yet')).toBeTruthy();
  });

  it('renders loading spinner when loading with no entries', () => {
    render(<ChatTimelineDrawer {...defaultProps} loading={true} />);
    expect(screen.queryByText('No timeline entries yet')).toBeNull();
    // Spinner is rendered (role=status or svg)
    expect(document.querySelector('[role="dialog"]')).toBeTruthy();
  });

  it('calls onClose when close button is clicked', () => {
    const onClose = vi.fn();
    render(<ChatTimelineDrawer {...defaultProps} onClose={onClose} />);
    const closeBtn = screen.getByLabelText('Close timeline');
    fireEvent.click(closeBtn);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('calls onClose when Escape key is pressed', () => {
    const onClose = vi.fn();
    render(<ChatTimelineDrawer {...defaultProps} onClose={onClose} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('calls onToggleContext when Context button is clicked', () => {
    const onToggleContext = vi.fn();
    render(<ChatTimelineDrawer {...defaultProps} onToggleContext={onToggleContext} />);
    const contextBtn = screen.getByText('Context');
    fireEvent.click(contextBtn);
    expect(onToggleContext).toHaveBeenCalledOnce();
  });

  it('sets aria-pressed on Context button based on showContext', () => {
    const { rerender } = render(<ChatTimelineDrawer {...defaultProps} showContext={false} />);
    const contextBtn = screen.getByText('Context').closest('button')!;
    expect(contextBtn.getAttribute('aria-pressed')).toBe('false');

    rerender(<ChatTimelineDrawer {...defaultProps} showContext={true} />);
    expect(contextBtn.getAttribute('aria-pressed')).toBe('true');
  });

  it('renders user message entries and calls onJumpToMessage on click', () => {
    const onJumpToMessage = vi.fn();
    const entries = [makeUserEntry({ id: 'msg-1', text: 'Test message', messageIndex: 5 })];
    render(<ChatTimelineDrawer {...defaultProps} entries={entries} onJumpToMessage={onJumpToMessage} />);

    const msgBtn = screen.getByText('Test message');
    fireEvent.click(msgBtn);
    expect(onJumpToMessage).toHaveBeenCalledWith(5);
  });

  it('renders system event entries', () => {
    const entries = [makeSystemEntry({ title: 'Session started', severity: 'info' })];
    render(<ChatTimelineDrawer {...defaultProps} entries={entries} />);
    expect(screen.getByText('Session started')).toBeTruthy();
  });

  it('renders progress notification entries as status updates', () => {
    const entries = [makeProgressEntry({ text: 'Cloned the repo and inspected timeline code' })];
    render(<ChatTimelineDrawer {...defaultProps} entries={entries} />);

    expect(screen.getByText('Status update')).toBeTruthy();
    expect(screen.getByText('Cloned the repo and inspected timeline code')).toBeTruthy();
  });

  it('has correct dialog aria attributes', () => {
    render(<ChatTimelineDrawer {...defaultProps} />);
    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-label')).toBe('Session timeline');
  });

  it('renders backdrop with aria-hidden="true"', () => {
    render(<ChatTimelineDrawer {...defaultProps} />);
    const dialog = screen.getByRole('dialog');
    // Backdrop is the sibling before the dialog panel
    const backdrop = dialog.previousElementSibling;
    expect(backdrop?.getAttribute('aria-hidden')).toBe('true');
  });
});
