import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { WorkspaceSidebar } from '../../../src/components/WorkspaceSidebar';
import type { SessionTokenUsage, SidebarTab } from '../../../src/components/WorkspaceSidebar';
import type { WorkspaceResponse } from '@simple-agent-manager/shared';
import type { Event } from '@simple-agent-manager/shared';
import type { GitStatusData } from '../../../src/lib/api';

// ─── Helpers ─────────────────────────────────────────────────

function makeWorkspace(overrides?: Partial<WorkspaceResponse>): WorkspaceResponse {
  return {
    id: 'ws-1',
    name: 'test-workspace',
    repository: 'owner/repo',
    branch: 'main',
    status: 'running',
    vmSize: 'small',
    vmLocation: 'nbg1',
    vmIp: '1.2.3.4',
    lastActivityAt: new Date().toISOString(),
    errorMessage: null,
    shutdownDeadline: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    idleTimeoutSeconds: 1800,
    createdAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeTabs(): SidebarTab[] {
  return [
    { id: 'terminal:t1', kind: 'terminal', sessionId: 't1', title: 'Terminal 1', status: 'connected' },
    { id: 'chat:c1', kind: 'chat', sessionId: 'c1', title: 'Claude Code 1', status: 'running' },
  ];
}

function makeGitStatus(): GitStatusData {
  return {
    staged: [{ path: 'src/a.ts', status: 'M' }],
    unstaged: [{ path: 'src/b.ts', status: 'M' }, { path: 'src/c.ts', status: 'M' }],
    untracked: [{ path: 'new.txt', status: '??' }],
  };
}

function makeTokenUsages(): SessionTokenUsage[] {
  return [
    {
      sessionId: 'c1',
      label: 'Claude Code 1',
      usage: { inputTokens: 12400, outputTokens: 3200, totalTokens: 15600 },
    },
  ];
}

function makeEvents(): Event[] {
  return [
    {
      id: 'e1',
      level: 'info',
      type: 'workspace.ready',
      message: 'Workspace is ready',
      createdAt: new Date().toISOString(),
    },
  ];
}

const defaultProps = {
  workspace: makeWorkspace(),
  isRunning: true,
  isMobile: false,
  actionLoading: false,
  onStop: vi.fn(),
  onRestart: vi.fn(),
  onRebuild: vi.fn(),
  displayNameInput: 'test-workspace',
  onDisplayNameChange: vi.fn(),
  onRename: vi.fn(),
  renaming: false,
  workspaceTabs: makeTabs(),
  activeTabId: 'terminal:t1',
  onSelectTab: vi.fn(),
  gitStatus: makeGitStatus(),
  onOpenGitChanges: vi.fn(),
  sessionTokenUsages: makeTokenUsages(),
  workspaceEvents: makeEvents(),
};

describe('WorkspaceSidebar', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });

  // ── Header / Lifecycle ──

  it('renders rename input and lifecycle buttons when running', () => {
    render(<WorkspaceSidebar {...defaultProps} />);
    expect(screen.getByDisplayValue('test-workspace')).toBeInTheDocument();
    expect(screen.getByText('Rename')).toBeInTheDocument();
    expect(screen.getByText('Rebuild')).toBeInTheDocument();
    expect(screen.getByText('Stop')).toBeInTheDocument();
  });

  it('shows Restart button when stopped', () => {
    render(
      <WorkspaceSidebar
        {...defaultProps}
        isRunning={false}
        workspace={makeWorkspace({ status: 'stopped' })}
      />
    );
    expect(screen.getByText('Restart')).toBeInTheDocument();
    expect(screen.queryByText('Stop')).not.toBeInTheDocument();
  });

  it('calls onStop when Stop is clicked', () => {
    const onStop = vi.fn();
    render(<WorkspaceSidebar {...defaultProps} onStop={onStop} />);
    fireEvent.click(screen.getByText('Stop'));
    expect(onStop).toHaveBeenCalledOnce();
  });

  it('calls onRename when Rename is clicked', () => {
    const onRename = vi.fn();
    render(<WorkspaceSidebar {...defaultProps} onRename={onRename} />);
    fireEvent.click(screen.getByText('Rename'));
    expect(onRename).toHaveBeenCalledOnce();
  });

  it('calls onRename on Enter key in name input', () => {
    const onRename = vi.fn();
    render(<WorkspaceSidebar {...defaultProps} onRename={onRename} />);
    fireEvent.keyDown(screen.getByDisplayValue('test-workspace'), { key: 'Enter' });
    expect(onRename).toHaveBeenCalledOnce();
  });

  // ── Workspace Info ──

  it('renders workspace info section with repo, branch, VM details', () => {
    render(<WorkspaceSidebar {...defaultProps} />);
    expect(screen.getByText('owner/repo')).toBeInTheDocument();
    expect(screen.getByText('main')).toBeInTheDocument();
    expect(screen.getByText(/CX22/)).toBeInTheDocument();
    expect(screen.getByText(/Nuremberg/)).toBeInTheDocument();
  });

  it('renders repository as external link', () => {
    render(<WorkspaceSidebar {...defaultProps} />);
    const link = screen.getByText('owner/repo').closest('a');
    expect(link).toHaveAttribute('href', 'https://github.com/owner/repo');
    expect(link).toHaveAttribute('target', '_blank');
  });

  it('shows shutdown countdown', () => {
    render(<WorkspaceSidebar {...defaultProps} />);
    // Deadline is 30 min in the future, so should show ~29-30m somewhere
    const allTimeTexts = screen.getAllByText(/\d+m/);
    expect(allTimeTexts.length).toBeGreaterThanOrEqual(1);
  });

  // ── Sessions ──

  it('renders session tabs with status dots', () => {
    render(<WorkspaceSidebar {...defaultProps} />);
    expect(screen.getByText('Terminal 1')).toBeInTheDocument();
    // "Claude Code 1" appears in both Sessions and Token Usage — use getAllByText
    expect(screen.getAllByText('Claude Code 1').length).toBeGreaterThanOrEqual(1);
  });

  it('shows active indicator on selected tab', () => {
    render(<WorkspaceSidebar {...defaultProps} activeTabId="terminal:t1" />);
    expect(screen.getByText('active')).toBeInTheDocument();
  });

  it('calls onSelectTab when a session row is clicked', () => {
    const onSelectTab = vi.fn();
    // Use only terminal tabs to avoid "Claude Code 1" duplicate
    const tabs: SidebarTab[] = [
      { id: 'terminal:t1', kind: 'terminal', sessionId: 't1', title: 'Terminal 1', status: 'connected' },
      { id: 'terminal:t2', kind: 'terminal', sessionId: 't2', title: 'Terminal 2', status: 'connected' },
    ];
    render(<WorkspaceSidebar {...defaultProps} workspaceTabs={tabs} sessionTokenUsages={[]} onSelectTab={onSelectTab} />);
    fireEvent.click(screen.getByText('Terminal 2'));
    expect(onSelectTab).toHaveBeenCalledOnce();
    expect(onSelectTab).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'terminal:t2', kind: 'terminal' })
    );
  });

  it('shows session count badge', () => {
    render(<WorkspaceSidebar {...defaultProps} />);
    // 2 tabs — badge appears as "2". Use getAllByText since "2" may appear elsewhere
    expect(screen.getAllByText('2').length).toBeGreaterThanOrEqual(1);
  });

  // ── Git Summary ──

  it('renders git summary with View Changes button', () => {
    render(<WorkspaceSidebar {...defaultProps} />);
    expect(screen.getByText('View Changes')).toBeInTheDocument();
    // "staged" appears in "1 staged", "unstaged" in "2 unstaged", "untracked" in "1 untracked"
    // The word "staged" appears in both "staged" and "unstaged", so use getAllByText
    expect(screen.getAllByText(/staged/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/unstaged/)).toBeInTheDocument();
    expect(screen.getByText(/untracked/)).toBeInTheDocument();
  });

  it('shows View Changes button that calls onOpenGitChanges', () => {
    const onOpenGitChanges = vi.fn();
    render(<WorkspaceSidebar {...defaultProps} onOpenGitChanges={onOpenGitChanges} />);
    fireEvent.click(screen.getByText('View Changes'));
    expect(onOpenGitChanges).toHaveBeenCalledOnce();
  });

  it('shows git badge with total count', () => {
    render(<WorkspaceSidebar {...defaultProps} />);
    // 1 staged + 2 unstaged + 1 untracked = 4
    expect(screen.getAllByText('4').length).toBeGreaterThanOrEqual(1);
  });

  // ── Token Usage ──

  it('renders token usage for sessions', () => {
    render(<WorkspaceSidebar {...defaultProps} />);
    expect(screen.getByText(/12\.4K in/)).toBeInTheDocument();
    expect(screen.getByText(/3\.2K out/)).toBeInTheDocument();
  });

  it('hides token usage section when no usage data', () => {
    render(<WorkspaceSidebar {...defaultProps} sessionTokenUsages={[]} />);
    expect(screen.queryByText('Token Usage')).not.toBeInTheDocument();
  });

  it('shows total row when multiple sessions have usage', () => {
    const usages: SessionTokenUsage[] = [
      { sessionId: 'c1', label: 'Claude Code 1', usage: { inputTokens: 10000, outputTokens: 2000, totalTokens: 12000 } },
      { sessionId: 'c2', label: 'Claude Code 2', usage: { inputTokens: 5000, outputTokens: 1000, totalTokens: 6000 } },
    ];
    render(<WorkspaceSidebar {...defaultProps} sessionTokenUsages={usages} />);
    expect(screen.getByText('Total')).toBeInTheDocument();
    expect(screen.getByText(/15\.0K in/)).toBeInTheDocument();
  });

  // ── Events ──

  it('renders events section collapsed by default', () => {
    render(<WorkspaceSidebar {...defaultProps} />);
    // Events section exists but content is hidden by default
    expect(screen.getByText(/Events/)).toBeInTheDocument();
    // The event message should NOT be visible (collapsed by default)
    expect(screen.queryByText('Workspace is ready')).not.toBeInTheDocument();
  });

  it('shows events when Events section is expanded', () => {
    render(<WorkspaceSidebar {...defaultProps} />);
    // Click the Events header to expand
    fireEvent.click(screen.getByText(/Events/));
    expect(screen.getByText('Workspace is ready')).toBeInTheDocument();
  });

  // ── Missing data handling ──

  it('handles null workspace gracefully', () => {
    render(<WorkspaceSidebar {...defaultProps} workspace={null} />);
    expect(screen.getByText('Workspace Info')).toBeInTheDocument();
  });

  it('handles null gitStatus gracefully', () => {
    render(<WorkspaceSidebar {...defaultProps} gitStatus={null} />);
    expect(screen.getByText('Loading...')).toBeInTheDocument();
  });

  it('hides git section when not running', () => {
    render(<WorkspaceSidebar {...defaultProps} isRunning={false} workspace={makeWorkspace({ status: 'stopped' })} />);
    expect(screen.queryByText('Git Changes')).not.toBeInTheDocument();
  });
});
