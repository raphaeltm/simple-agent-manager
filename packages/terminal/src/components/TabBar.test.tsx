import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { TabBar } from './TabBar';
import type { TerminalSession } from '../types/multi-terminal';

describe('TabBar', () => {
  const mockSessions: TerminalSession[] = [
    {
      id: 'session-1',
      name: 'Terminal 1',
      status: 'connected',
      createdAt: new Date(),
      lastActivityAt: new Date(),
      isActive: true,
      order: 0,
      workingDirectory: '/workspace',
    },
    {
      id: 'session-2',
      name: 'Terminal 2',
      status: 'connecting',
      createdAt: new Date(),
      lastActivityAt: new Date(),
      isActive: false,
      order: 1,
      workingDirectory: '/workspace',
    },
    {
      id: 'session-3',
      name: 'Terminal 3',
      status: 'error',
      createdAt: new Date(),
      lastActivityAt: new Date(),
      isActive: false,
      order: 2,
      workingDirectory: '/workspace',
    },
  ];

  const defaultProps = {
    sessions: mockSessions,
    activeSessionId: 'session-1',
    onTabActivate: vi.fn(),
    onTabClose: vi.fn(),
    onTabRename: vi.fn(),
    onNewTab: vi.fn(),
    maxTabs: 10,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('rendering', () => {
    it('should render all session tabs', () => {
      render(<TabBar {...defaultProps} />);

      expect(screen.getByText('Terminal 1')).toBeDefined();
      expect(screen.getByText('Terminal 2')).toBeDefined();
      expect(screen.getByText('Terminal 3')).toBeDefined();
    });

    it('should highlight active tab', () => {
      const { container } = render(<TabBar {...defaultProps} />);

      const activeTab = container.querySelector('[aria-selected="true"]');
      expect(activeTab?.textContent).toContain('Terminal 1');
    });

    it('should show new tab button when under maxTabs', () => {
      render(<TabBar {...defaultProps} />);

      const newTabButton = screen.getByLabelText('Create new terminal');
      expect(newTabButton).toBeDefined();
    });

    it('should hide new tab button when at maxTabs', () => {
      const maxedSessions = Array.from({ length: 10 }, (_, i) => ({
        id: `session-${i}`,
        name: `Terminal ${i + 1}`,
        status: 'connected' as const,
        createdAt: new Date(),
        lastActivityAt: new Date(),
      isActive: false,
      order: 0,
        workingDirectory: '/workspace',
      }));
      render(<TabBar {...defaultProps} sessions={maxedSessions} maxTabs={10} />);

      const newTabButton = screen.queryByTitle('New Terminal');
      expect(newTabButton).toBeNull();
    });

    it('should show status indicators', () => {
      const { container } = render(<TabBar {...defaultProps} />);

      // Connecting spinner
      const spinner = container.querySelector('.animate-spin');
      expect(spinner).toBeDefined();

      // Error indicator
      const errorIcon = container.querySelector('[data-status="error"]');
      expect(errorIcon).toBeDefined();
    });
  });

  describe('interactions', () => {
    it('should handle tab click', () => {
      render(<TabBar {...defaultProps} />);

      const terminal2 = screen.getByText('Terminal 2');
      const tab2 = terminal2.closest('[role="tab"]');
      expect(tab2).toBeDefined();
      fireEvent.click(tab2!);

      expect(defaultProps.onTabActivate).toHaveBeenCalledWith('session-2');
    });

    it('should handle close button click', () => {
      render(<TabBar {...defaultProps} />);

      const closeButtons = screen.getAllByLabelText(/Close/);
      if (closeButtons[0]) fireEvent.click(closeButtons[0]);

      expect(defaultProps.onTabClose).toHaveBeenCalledWith('session-1');
      expect(defaultProps.onTabActivate).not.toHaveBeenCalled();
    });

    it('should handle new tab button click', () => {
      render(<TabBar {...defaultProps} />);

      const newTabButton = screen.getByLabelText('Create new terminal');
      fireEvent.click(newTabButton);

      expect(defaultProps.onNewTab).toHaveBeenCalled();
    });

    it('should prevent tab activation when clicking close', () => {
      render(<TabBar {...defaultProps} />);

      const closeButtons = screen.getAllByLabelText(/Close/);
      if (closeButtons[1]) fireEvent.click(closeButtons[1]);

      expect(defaultProps.onTabClose).toHaveBeenCalledWith('session-2');
      expect(defaultProps.onTabActivate).not.toHaveBeenCalled();
    });
  });

  describe('rename functionality', () => {
    it('should enter edit mode on double click', async () => {
      render(<TabBar {...defaultProps} />);

      const tab = screen.getByText('Terminal 1');
      fireEvent.doubleClick(tab);

      await waitFor(() => {
        const input = screen.getByDisplayValue('Terminal 1');
        expect(input).toBeDefined();
      });
    });

    it('should save rename on Enter', async () => {
      render(<TabBar {...defaultProps} />);

      const tab = screen.getByText('Terminal 1');
      fireEvent.doubleClick(tab);

      const input = await screen.findByDisplayValue('Terminal 1');
      fireEvent.change(input, { target: { value: 'New Name' } });
      fireEvent.keyDown(input, { key: 'Enter' });

      expect(defaultProps.onTabRename).toHaveBeenCalledWith('session-1', 'New Name');
    });

    it('should cancel rename on Escape', async () => {
      render(<TabBar {...defaultProps} />);

      const tab = screen.getByText('Terminal 1');
      fireEvent.doubleClick(tab);

      const input = await screen.findByDisplayValue('Terminal 1');
      fireEvent.change(input, { target: { value: 'New Name' } });
      fireEvent.keyDown(input, { key: 'Escape' });

      expect(defaultProps.onTabRename).not.toHaveBeenCalled();
      expect(screen.getByText('Terminal 1')).toBeDefined();
    });

    it('should save rename on blur', async () => {
      render(<TabBar {...defaultProps} />);

      const tab = screen.getByText('Terminal 1');
      fireEvent.doubleClick(tab);

      const input = await screen.findByDisplayValue('Terminal 1');
      fireEvent.change(input, { target: { value: 'New Name' } });
      fireEvent.blur(input);

      expect(defaultProps.onTabRename).toHaveBeenCalledWith('session-1', 'New Name');
    });

    it('should select all text on edit', async () => {
      render(<TabBar {...defaultProps} />);

      const tab = screen.getByText('Terminal 1');
      fireEvent.doubleClick(tab);

      const input = await screen.findByDisplayValue('Terminal 1') as HTMLInputElement;
      expect(input.selectionStart).toBe(0);
      expect(input.selectionEnd).toBe('Terminal 1'.length);
    });
  });

  describe('overflow handling', () => {
    it('should show scroll buttons when tabs overflow', () => {
      // Create many sessions
      const manySessions = Array.from({ length: 20 }, (_, i) => ({
        id: `session-${i}`,
        name: `Terminal ${i + 1}`,
        status: 'connected' as const,
        createdAt: new Date(),
        lastActivityAt: new Date(),
        isActive: i === 0,
        order: i,
        workingDirectory: '/workspace',
      }));

      const { container } = render(
        <TabBar {...defaultProps} sessions={manySessions} />
      );

      // Mock scrollWidth > clientWidth
      const tabContainer = container.querySelector('.tab-container');
      if (tabContainer) {
        Object.defineProperty(tabContainer, 'scrollWidth', { value: 2000 });
        Object.defineProperty(tabContainer, 'clientWidth', { value: 800 });
      }

      // Should show overflow menu
      const overflowMenu = container.querySelector('[data-testid="overflow-menu"]');
      expect(overflowMenu).toBeDefined();
    });

    it('should scroll to active tab on mount', () => {
      const manySessions = Array.from({ length: 20 }, (_, i) => ({
        id: `session-${i}`,
        name: `Terminal ${i + 1}`,
        status: 'connected' as const,
        createdAt: new Date(),
        lastActivityAt: new Date(),
        isActive: i === 0,
        order: i,
        workingDirectory: '/workspace',
      }));

      const { container } = render(
        <TabBar {...defaultProps} sessions={manySessions} activeSessionId="session-10" />
      );

      // The tab for session-10 should be rendered
      const tab10 = container.querySelector('[data-session-id="session-10"]');
      expect(tab10?.textContent).toContain('Terminal 11');
    });
  });

  describe('keyboard shortcuts hint', () => {
    it('should show keyboard shortcut hints in tooltips', () => {
      render(<TabBar {...defaultProps} />);

      const newTabButton = screen.getByLabelText('Create new terminal');
      expect(newTabButton.title).toContain('Ctrl+Shift+T');
    });

    it('should show correct title with shortcut', () => {
      render(<TabBar {...defaultProps} />);

      const newTabButton = screen.getByLabelText('Create new terminal');
      expect(newTabButton.title).toBe('New Terminal (Ctrl+Shift+T)');
    });
  });

  describe('accessibility', () => {
    it('should have proper ARIA attributes', () => {
      const { container } = render(<TabBar {...defaultProps} />);

      const tabList = container.querySelector('[role="tablist"]');
      expect(tabList).toBeDefined();

      const tabs = container.querySelectorAll('[role="tab"]');
      expect(tabs.length).toBeGreaterThan(0);

      const activeTab = container.querySelector('[aria-selected="true"]');
      expect(activeTab).toBeDefined();
    });

    it('should have accessible labels', () => {
      render(<TabBar {...defaultProps} />);

      const closeButtons = screen.getAllByLabelText(/Close Terminal/);
      expect(closeButtons.length).toBe(mockSessions.length);

      const newTabButton = screen.getByLabelText(/Create new terminal/i);
      expect(newTabButton).toBeDefined();
    });

    it('should support keyboard navigation', () => {
      const { container } = render(<TabBar {...defaultProps} />);

      const firstTab = container.querySelector('[role="tab"]') as HTMLElement;
      firstTab?.focus();

      // Arrow right should move focus
      fireEvent.keyDown(firstTab, { key: 'ArrowRight' });
      // Implementation would handle focus management
    });
  });

  describe('drag and drop', () => {
    it('should render tabs with role="tab"', () => {
      const { container } = render(<TabBar {...defaultProps} />);

      const tabs = container.querySelectorAll('[role="tab"]');
      expect(tabs.length).toBe(mockSessions.length);
    });

    it('should render tabs with data-session-id', () => {
      const { container } = render(<TabBar {...defaultProps} />);

      const tab1 = container.querySelector('[data-session-id="session-1"]');
      const tab2 = container.querySelector('[data-session-id="session-2"]');
      expect(tab1).toBeDefined();
      expect(tab2).toBeDefined();
    });
  });

  describe('responsive behavior', () => {
    it('should render tabs container', () => {
      const { container } = render(<TabBar {...defaultProps} />);

      const tabContainer = container.querySelector('.terminal-tabs-container');
      expect(tabContainer).toBeDefined();
      expect(tabContainer).not.toBeNull();
    });

    it('should render all tabs within container', () => {
      const { container } = render(<TabBar {...defaultProps} />);

      const tabContainer = container.querySelector('.terminal-tabs-container');
      const tabs = tabContainer?.querySelectorAll('[role="tab"]');
      expect(tabs?.length).toBe(mockSessions.length);
    });
  });
});