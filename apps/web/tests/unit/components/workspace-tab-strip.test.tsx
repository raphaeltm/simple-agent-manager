import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import {
  WorkspaceTabStrip,
  type WorkspaceTabItem,
} from '../../../src/components/WorkspaceTabStrip';

function makeTabs(...specs: Array<[string, string, 'terminal' | 'chat']>): WorkspaceTabItem[] {
  return specs.map(([id, title, kind]) => ({
    id,
    kind,
    sessionId: id.replace(/^(terminal|chat):/, ''),
    title,
    statusColor: '#9ece6a',
  }));
}

const defaultTabs = makeTabs(
  ['terminal:t1', 'Terminal 1', 'terminal'],
  ['chat:c1', 'Claude Code 1', 'chat'],
  ['chat:c2', 'Claude Code 2', 'chat']
);

describe('WorkspaceTabStrip', () => {
  const defaultProps = {
    tabs: defaultTabs,
    activeTabId: 'terminal:t1',
    isMobile: false,
    onSelect: vi.fn(),
    onClose: vi.fn(),
    onRename: vi.fn(),
    createMenuSlot: <div data-testid="create-menu">+</div>,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders all tabs', () => {
    render(<WorkspaceTabStrip {...defaultProps} />);

    expect(screen.getByText('Terminal 1')).toBeInTheDocument();
    expect(screen.getByText('Claude Code 1')).toBeInTheDocument();
    expect(screen.getByText('Claude Code 2')).toBeInTheDocument();
  });

  it('renders the create menu slot', () => {
    render(<WorkspaceTabStrip {...defaultProps} />);

    expect(screen.getByTestId('create-menu')).toBeInTheDocument();
  });

  it('marks the active tab with aria-selected', () => {
    render(<WorkspaceTabStrip {...defaultProps} activeTabId="chat:c1" />);

    const chatTab = screen.getByRole('tab', { name: /Chat tab: Claude Code 1/ });
    expect(chatTab).toHaveAttribute('aria-selected', 'true');

    const termTab = screen.getByRole('tab', { name: /Terminal tab: Terminal 1/ });
    expect(termTab).toHaveAttribute('aria-selected', 'false');
  });

  it('calls onSelect when a tab is clicked', () => {
    render(<WorkspaceTabStrip {...defaultProps} />);

    fireEvent.click(screen.getByText('Claude Code 1'));

    expect(defaultProps.onSelect).toHaveBeenCalledTimes(1);
    expect(defaultProps.onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'chat:c1' }));
  });

  it('calls onSelect when Enter is pressed on a tab', () => {
    render(<WorkspaceTabStrip {...defaultProps} />);

    const tab = screen.getByRole('tab', { name: /Chat tab: Claude Code 1/ });
    fireEvent.keyDown(tab, { key: 'Enter' });

    expect(defaultProps.onSelect).toHaveBeenCalledTimes(1);
  });

  it('calls onClose when close button is clicked', () => {
    render(<WorkspaceTabStrip {...defaultProps} />);

    const closeButtons = screen.getAllByRole('button', { name: /Close|Stop/ });
    fireEvent.click(closeButtons[0]!);

    expect(defaultProps.onClose).toHaveBeenCalledTimes(1);
  });

  it('renders close button for terminal tabs', () => {
    render(<WorkspaceTabStrip {...defaultProps} />);

    const closeTerminalButton = screen.getByRole('button', { name: 'Close Terminal 1' });
    expect(closeTerminalButton).toBeInTheDocument();
  });

  // ── Rename tests ──

  it('enters edit mode on double-click', () => {
    render(<WorkspaceTabStrip {...defaultProps} />);

    const tab = screen.getByRole('tab', { name: /Chat tab: Claude Code 1/ });
    fireEvent.doubleClick(tab);

    const input = screen.getByRole('textbox', { name: 'Rename tab' });
    expect(input).toBeInTheDocument();
    expect(input).toHaveValue('Claude Code 1');
  });

  it('commits rename on Enter', () => {
    render(<WorkspaceTabStrip {...defaultProps} />);

    const tab = screen.getByRole('tab', { name: /Chat tab: Claude Code 1/ });
    fireEvent.doubleClick(tab);

    const input = screen.getByRole('textbox', { name: 'Rename tab' });
    fireEvent.change(input, { target: { value: 'My Custom Name' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(defaultProps.onRename).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'chat:c1' }),
      'My Custom Name'
    );
  });

  it('cancels rename on Escape', () => {
    render(<WorkspaceTabStrip {...defaultProps} />);

    const tab = screen.getByRole('tab', { name: /Chat tab: Claude Code 1/ });
    fireEvent.doubleClick(tab);

    const input = screen.getByRole('textbox', { name: 'Rename tab' });
    fireEvent.change(input, { target: { value: 'Changed' } });
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(defaultProps.onRename).not.toHaveBeenCalled();
    // Should exit edit mode
    expect(screen.queryByRole('textbox', { name: 'Rename tab' })).not.toBeInTheDocument();
  });

  it('commits rename on blur', () => {
    render(<WorkspaceTabStrip {...defaultProps} />);

    const tab = screen.getByRole('tab', { name: /Chat tab: Claude Code 1/ });
    fireEvent.doubleClick(tab);

    const input = screen.getByRole('textbox', { name: 'Rename tab' });
    fireEvent.change(input, { target: { value: 'Blurred Name' } });
    fireEvent.blur(input);

    expect(defaultProps.onRename).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'chat:c1' }),
      'Blurred Name'
    );
  });

  it('does not call onRename when name is unchanged', () => {
    render(<WorkspaceTabStrip {...defaultProps} />);

    const tab = screen.getByRole('tab', { name: /Chat tab: Claude Code 1/ });
    fireEvent.doubleClick(tab);

    const input = screen.getByRole('textbox', { name: 'Rename tab' });
    // Don't change the value, just commit
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(defaultProps.onRename).not.toHaveBeenCalled();
  });

  it('truncates rename to 50 characters', () => {
    render(<WorkspaceTabStrip {...defaultProps} />);

    const tab = screen.getByRole('tab', { name: /Chat tab: Claude Code 1/ });
    fireEvent.doubleClick(tab);

    const input = screen.getByRole('textbox', { name: 'Rename tab' });
    const longName = 'A'.repeat(60);
    fireEvent.change(input, { target: { value: longName } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(defaultProps.onRename).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'chat:c1' }),
      'A'.repeat(50)
    );
  });

  it('does not call onRename for whitespace-only input', () => {
    render(<WorkspaceTabStrip {...defaultProps} />);

    const tab = screen.getByRole('tab', { name: /Chat tab: Claude Code 1/ });
    fireEvent.doubleClick(tab);

    const input = screen.getByRole('textbox', { name: 'Rename tab' });
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(defaultProps.onRename).not.toHaveBeenCalled();
  });

  it('renders status dots for each tab', () => {
    render(<WorkspaceTabStrip {...defaultProps} />);

    // Each tab should have a status dot (●)
    const dots = screen.getAllByText('●');
    expect(dots).toHaveLength(3);
  });

  it('renders worktree badges when provided', () => {
    const tabsWithBadges: WorkspaceTabItem[] = [
      { ...defaultTabs[0]!, badge: 'main' },
      { ...defaultTabs[1]!, badge: 'feature-auth' },
      defaultTabs[2]!,
    ];

    render(<WorkspaceTabStrip {...defaultProps} tabs={tabsWithBadges} />);

    expect(screen.getByText('main')).toBeInTheDocument();
    expect(screen.getByText('feature-auth')).toBeInTheDocument();
  });

  it('has correct tablist role on the container', () => {
    render(<WorkspaceTabStrip {...defaultProps} />);

    expect(screen.getByRole('tablist')).toBeInTheDocument();
  });
});
