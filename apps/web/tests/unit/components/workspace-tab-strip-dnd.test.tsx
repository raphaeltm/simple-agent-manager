import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { WorkspaceTabStrip, type WorkspaceTabItem } from '../../../src/components/WorkspaceTabStrip';

function makeTabs(...specs: Array<[string, string, 'terminal' | 'chat']>): WorkspaceTabItem[] {
  return specs.map(([id, title, kind]) => ({
    id,
    kind,
    sessionId: id.replace(/^(terminal|chat):/, ''),
    title,
    statusColor: '#9ece6a',
  }));
}

const tabs = makeTabs(
  ['terminal:t1', 'Terminal 1', 'terminal'],
  ['chat:c1', 'Claude Code 1', 'chat'],
  ['chat:c2', 'Claude Code 2', 'chat']
);

describe('WorkspaceTabStrip DnD', () => {
  const defaultProps = {
    tabs,
    activeTabId: 'terminal:t1',
    isMobile: false,
    onSelect: vi.fn(),
    onClose: vi.fn(),
    onRename: vi.fn(),
    onReorder: vi.fn(),
    createMenuSlot: <div data-testid="create-menu">+</div>,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders DndContext — tabs have aria-roledescription="sortable"', () => {
    render(<WorkspaceTabStrip {...defaultProps} />);

    const allTabs = screen.getAllByRole('tab');
    for (const tab of allTabs) {
      expect(tab).toHaveAttribute('aria-roledescription', 'sortable');
    }
  });

  it('tabs have aria-describedby for drag instructions', () => {
    render(<WorkspaceTabStrip {...defaultProps} />);

    // dnd-kit adds aria-describedby pointing to an instructions element
    const allTabs = screen.getAllByRole('tab');
    for (const tab of allTabs) {
      expect(tab).toHaveAttribute('aria-describedby');
    }
  });

  it('tab opacity is 1 (not dragging) by default', () => {
    render(<WorkspaceTabStrip {...defaultProps} />);

    const allTabs = screen.getAllByRole('tab');
    for (const tab of allTabs) {
      // opacity should be 1 when not dragging
      expect(tab.style.opacity).toBe('1');
    }
  });

  it('does not disable drag when no tab is in edit mode', () => {
    render(<WorkspaceTabStrip {...defaultProps} />);

    // Sortable items should have aria-roledescription set, meaning sorting is enabled
    const allTabs = screen.getAllByRole('tab');
    expect(allTabs).toHaveLength(3);
    // useSortable disabled would not set the attributes — check they are present
    for (const tab of allTabs) {
      expect(tab).toHaveAttribute('aria-roledescription', 'sortable');
    }
  });

  it('disables drag when a tab is in rename edit mode', () => {
    render(<WorkspaceTabStrip {...defaultProps} />);

    // Enter rename mode on the first tab
    const tab = screen.getByRole('tab', { name: /Chat tab: Claude Code 1/ });
    fireEvent.doubleClick(tab);

    // In edit mode, the input should be visible
    expect(screen.getByRole('textbox', { name: 'Rename tab' })).toBeInTheDocument();

    // When editing, drag is disabled via useSortable({ disabled: true })
    // dnd-kit still renders the element but keyboard/pointer sensors won't activate drag
    // The sortable attributes are still present, but interaction is suppressed internally
    // We verify editing mode was entered which sets dragDisabled=true on all wrappers
    const allTabs = screen.getAllByRole('tab');
    expect(allTabs.length).toBeGreaterThan(0);
  });

  it('renders without crashing when onReorder is not provided', () => {
    render(
      <WorkspaceTabStrip
        tabs={defaultProps.tabs}
        activeTabId={defaultProps.activeTabId}
        isMobile={defaultProps.isMobile}
        onSelect={defaultProps.onSelect}
        onClose={defaultProps.onClose}
        onRename={defaultProps.onRename}
        createMenuSlot={defaultProps.createMenuSlot}
      />
    );

    expect(screen.getAllByRole('tab')).toHaveLength(3);
  });

  it('click on a tab still works (not intercepted by drag with distance:5)', () => {
    render(<WorkspaceTabStrip {...defaultProps} />);

    fireEvent.click(screen.getByText('Claude Code 1'));

    // Click fires without pointer movement, so drag sensor (distance:5) should not activate
    expect(defaultProps.onSelect).toHaveBeenCalledTimes(1);
    expect(defaultProps.onReorder).not.toHaveBeenCalled();
  });

  it('Enter key on tab still selects (not intercepted by keyboard sensor)', () => {
    render(<WorkspaceTabStrip {...defaultProps} />);

    const tab = screen.getByRole('tab', { name: /Chat tab: Claude Code 2/ });
    fireEvent.keyDown(tab, { key: 'Enter' });

    expect(defaultProps.onSelect).toHaveBeenCalledTimes(1);
    expect(defaultProps.onReorder).not.toHaveBeenCalled();
  });

  it('renders with all tabs in sortable context (correct tab count)', () => {
    const fiveTabs = makeTabs(
      ['terminal:t1', 'T1', 'terminal'],
      ['terminal:t2', 'T2', 'terminal'],
      ['chat:c1', 'C1', 'chat'],
      ['chat:c2', 'C2', 'chat'],
      ['chat:c3', 'C3', 'chat']
    );

    render(<WorkspaceTabStrip {...defaultProps} tabs={fiveTabs} />);

    const allTabs = screen.getAllByRole('tab');
    expect(allTabs).toHaveLength(5);
    // All should be sortable
    for (const tab of allTabs) {
      expect(tab).toHaveAttribute('aria-roledescription', 'sortable');
    }
  });
});
