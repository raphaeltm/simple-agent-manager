import { useState, useEffect, useMemo, type FC } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '@simple-agent-manager/ui';
import { GitBranch, ExternalLink } from 'lucide-react';
import { CollapsibleSection } from './CollapsibleSection';
import type { WorkspaceResponse, Event } from '@simple-agent-manager/shared';
import type { GitStatusData } from '../lib/api';
import type { TokenUsage } from '@simple-agent-manager/acp-client';

// ─── Types ───────────────────────────────────────────────────

export interface SessionTokenUsage {
  sessionId: string;
  label: string;
  usage: TokenUsage;
}

export interface SidebarTab {
  id: string;
  kind: 'terminal' | 'chat';
  sessionId: string;
  title: string;
  status: string;
}

interface WorkspaceSidebarProps {
  workspace: WorkspaceResponse | null;
  isRunning: boolean;
  isMobile: boolean;

  // Lifecycle actions
  actionLoading: boolean;
  onStop: () => void;
  onRestart: () => void;
  onRebuild: () => void;

  // Rename
  displayNameInput: string;
  onDisplayNameChange: (value: string) => void;
  onRename: () => void;
  renaming: boolean;

  // Sessions
  workspaceTabs: SidebarTab[];
  activeTabId: string | null;
  onSelectTab: (tab: SidebarTab) => void;

  // Git
  gitStatus: GitStatusData | null;
  onOpenGitChanges: () => void;

  // Token usage (aggregated from ChatSession callbacks)
  sessionTokenUsages: SessionTokenUsage[];

  // Events
  workspaceEvents: Event[];
}

// ─── Helpers ─────────────────────────────────────────────────

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

const VM_SIZE_LABELS: Record<string, string> = {
  small: 'CX22 (2 vCPU / 4 GB)',
  medium: 'CX32 (4 vCPU / 8 GB)',
  large: 'CX42 (8 vCPU / 16 GB)',
};

const VM_LOCATION_LABELS: Record<string, string> = {
  nbg1: 'Nuremberg',
  fsn1: 'Falkenstein',
  hel1: 'Helsinki',
};

function useRelativeTime(isoDate: string | null | undefined): string {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!isoDate) return;
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [isoDate]);

  if (!isoDate) return '-';

  const ms = now - new Date(isoDate).getTime();
  if (ms < 0) return 'just now';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function useCountdown(deadline: string | null | undefined): string {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!deadline) return;
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [deadline]);

  if (!deadline) return '-';

  const ms = new Date(deadline).getTime() - now;
  if (ms <= 0) return 'expired';
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  return `${minutes}m ${seconds % 60}s`;
}

function sessionStatusColor(status: string): string {
  switch (status) {
    case 'connected':
    case 'running':
      return '#9ece6a';
    case 'connecting':
    case 'reconnecting':
      return '#e0af68';
    case 'error':
      return '#f7768e';
    default:
      return '#787c99';
  }
}

// ─── Component ───────────────────────────────────────────────

export const WorkspaceSidebar: FC<WorkspaceSidebarProps> = ({
  workspace,
  isRunning,
  isMobile,
  actionLoading,
  onStop,
  onRestart,
  onRebuild,
  displayNameInput,
  onDisplayNameChange,
  onRename,
  renaming,
  workspaceTabs,
  activeTabId,
  onSelectTab,
  gitStatus,
  onOpenGitChanges,
  sessionTokenUsages,
  workspaceEvents,
}) => {
  const uptime = useRelativeTime(workspace?.createdAt);
  const countdown = useCountdown(workspace?.shutdownDeadline);

  const gitTotal = gitStatus
    ? gitStatus.staged.length + gitStatus.unstaged.length + gitStatus.untracked.length
    : 0;

  const totalUsage = useMemo(() => {
    const totals = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    for (const s of sessionTokenUsages) {
      totals.inputTokens += s.usage.inputTokens;
      totals.outputTokens += s.usage.outputTokens;
      totals.totalTokens += s.usage.totalTokens;
    }
    return totals;
  }, [sessionTokenUsages]);

  const repoUrl = workspace?.repository
    ? `https://github.com/${workspace.repository}`
    : null;

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        overflow: 'hidden',
      }}
    >
      {/* ── Header: name + lifecycle ── */}
      <div
        style={{
          padding: '10px 12px',
          borderBottom: '1px solid var(--sam-color-border-default)',
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          flexShrink: 0,
        }}
      >
        <div style={{ display: 'flex', gap: 'var(--sam-space-2)' }}>
          <input
            value={displayNameInput}
            onChange={(event) => onDisplayNameChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') onRename();
            }}
            placeholder="Workspace name"
            style={{
              flex: 1,
              borderRadius: 'var(--sam-radius-sm)',
              border: '1px solid var(--sam-color-border-default)',
              background: 'var(--sam-color-bg-canvas)',
              color: 'var(--sam-color-fg-primary)',
              padding: '5px 8px',
              fontSize: '0.8125rem',
              minWidth: 0,
            }}
          />
          <Button
            size="sm"
            onClick={onRename}
            disabled={renaming || !displayNameInput.trim()}
          >
            {renaming ? 'Saving...' : 'Rename'}
          </Button>
        </div>

        {/* Lifecycle buttons */}
        <div style={{ display: 'flex', gap: 'var(--sam-space-2)' }}>
          {isRunning && (
            <>
              <Button
                variant="secondary"
                size="sm"
                onClick={onRebuild}
                disabled={actionLoading}
                loading={actionLoading}
                style={{ flex: 1 }}
              >
                Rebuild
              </Button>
              <Button
                variant="danger"
                size="sm"
                onClick={onStop}
                disabled={actionLoading}
                loading={actionLoading}
                style={{ flex: 1 }}
              >
                Stop
              </Button>
            </>
          )}
          {workspace?.status === 'stopped' && (
            <Button
              variant="primary"
              size="sm"
              onClick={onRestart}
              disabled={actionLoading}
              loading={actionLoading}
              style={{ flex: 1 }}
            >
              Restart
            </Button>
          )}
        </div>
      </div>

      {/* ── Scrollable sections ── */}
      <div style={{ flex: 1, overflow: 'auto' }}>
        {/* Workspace Info */}
        <CollapsibleSection
          title="Workspace Info"
          storageKey="sam-sidebar-workspace-info"
        >
          <div style={{ display: 'grid', gap: 6, fontSize: '0.8125rem' }}>
            {/* Repository */}
            {workspace?.repository && (
              <InfoRow label="Repository">
                {repoUrl ? (
                  <a
                    href={repoUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{
                      color: '#7aa2f7',
                      textDecoration: 'none',
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 4,
                    }}
                  >
                    {workspace.repository}
                    <ExternalLink size={11} />
                  </a>
                ) : (
                  <span>{workspace.repository}</span>
                )}
              </InfoRow>
            )}

            {/* Branch */}
            {workspace?.branch && (
              <InfoRow label="Branch">
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  <GitBranch size={12} style={{ color: 'var(--sam-color-fg-muted)' }} />
                  {workspace.branch}
                </span>
              </InfoRow>
            )}

            {/* VM */}
            {workspace?.vmSize && (
              <InfoRow label="VM">
                {VM_SIZE_LABELS[workspace.vmSize] ?? workspace.vmSize}
                {workspace.vmLocation
                  ? ` \u00B7 ${VM_LOCATION_LABELS[workspace.vmLocation] ?? workspace.vmLocation}`
                  : ''}
              </InfoRow>
            )}

            {/* Node */}
            {workspace?.nodeId && (
              <InfoRow label="Node">
                <Link
                  to={`/nodes/${workspace.nodeId}`}
                  style={{
                    color: '#7aa2f7',
                    textDecoration: 'none',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 4,
                  }}
                >
                  {workspace.nodeId.slice(0, 8)}
                  <ExternalLink size={11} />
                </Link>
              </InfoRow>
            )}

            {/* Uptime */}
            <InfoRow label="Uptime">{uptime}</InfoRow>

            {/* Shutdown */}
            {workspace?.shutdownDeadline && (
              <InfoRow label="Shutdown in">
                <span
                  style={{
                    color: countdown === 'expired' ? '#f7768e' : undefined,
                  }}
                >
                  {countdown}
                </span>
              </InfoRow>
            )}
          </div>
        </CollapsibleSection>

        {/* Sessions */}
        {workspaceTabs.length > 0 && (
          <CollapsibleSection
            title="Sessions"
            badge={workspaceTabs.length}
            storageKey="sam-sidebar-sessions"
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              {workspaceTabs.map((tab) => {
                const active = activeTabId === tab.id;
                return (
                  <button
                    key={tab.id}
                    onClick={() => onSelectTab(tab)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      padding: isMobile ? '8px 6px' : '5px 6px',
                      minHeight: isMobile ? 44 : undefined,
                      borderRadius: 'var(--sam-radius-sm)',
                      border: 'none',
                      background: active
                        ? 'rgba(122, 162, 247, 0.1)'
                        : 'transparent',
                      cursor: 'pointer',
                      width: '100%',
                      textAlign: 'left',
                      fontSize: '0.8125rem',
                      color: active
                        ? 'var(--sam-color-fg-primary)'
                        : 'var(--sam-color-fg-muted)',
                    }}
                  >
                    <span
                      style={{
                        display: 'inline-block',
                        width: 7,
                        height: 7,
                        borderRadius: '50%',
                        backgroundColor: sessionStatusColor(tab.status),
                        flexShrink: 0,
                      }}
                    />
                    <span
                      style={{
                        flex: 1,
                        minWidth: 0,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {tab.title}
                    </span>
                    {active && (
                      <span
                        style={{
                          fontSize: '0.6875rem',
                          color: '#7aa2f7',
                          flexShrink: 0,
                        }}
                      >
                        active
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </CollapsibleSection>
        )}

        {/* Git Summary */}
        {isRunning && (
          <CollapsibleSection
            title="Git Changes"
            badge={gitTotal || undefined}
            storageKey="sam-sidebar-git"
          >
            {gitStatus ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div
                  style={{
                    display: 'flex',
                    gap: 12,
                    fontSize: '0.8125rem',
                    color: 'var(--sam-color-fg-muted)',
                  }}
                >
                  <span>
                    <strong style={{ color: '#9ece6a' }}>{gitStatus.staged.length}</strong> staged
                  </span>
                  <span>
                    <strong style={{ color: '#e0af68' }}>{gitStatus.unstaged.length}</strong> unstaged
                  </span>
                  <span>
                    <strong style={{ color: '#787c99' }}>{gitStatus.untracked.length}</strong> untracked
                  </span>
                </div>
                <button
                  onClick={onOpenGitChanges}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                    padding: '4px 0',
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    color: '#7aa2f7',
                    fontSize: '0.75rem',
                    textAlign: 'left',
                  }}
                >
                  <GitBranch size={12} />
                  View Changes
                </button>
              </div>
            ) : (
              <span style={{ fontSize: '0.8125rem', color: 'var(--sam-color-fg-muted)' }}>
                Loading...
              </span>
            )}
          </CollapsibleSection>
        )}

        {/* Token Usage */}
        {sessionTokenUsages.length > 0 && totalUsage.totalTokens > 0 && (
          <CollapsibleSection
            title="Token Usage"
            storageKey="sam-sidebar-tokens"
          >
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 6,
                fontSize: '0.8125rem',
              }}
            >
              {sessionTokenUsages
                .filter((s) => s.usage.totalTokens > 0)
                .map((s) => (
                  <div
                    key={s.sessionId}
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      color: 'var(--sam-color-fg-muted)',
                    }}
                  >
                    <span
                      style={{
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        minWidth: 0,
                        flex: 1,
                      }}
                    >
                      {s.label}
                    </span>
                    <span style={{ flexShrink: 0, marginLeft: 8, fontVariantNumeric: 'tabular-nums' }}>
                      {formatTokens(s.usage.inputTokens)} in / {formatTokens(s.usage.outputTokens)} out
                    </span>
                  </div>
                ))}
              {sessionTokenUsages.filter((s) => s.usage.totalTokens > 0).length > 1 && (
                <>
                  <div
                    style={{
                      borderTop: '1px solid var(--sam-color-border-default)',
                      paddingTop: 4,
                      display: 'flex',
                      justifyContent: 'space-between',
                      fontWeight: 600,
                      color: 'var(--sam-color-fg-primary)',
                    }}
                  >
                    <span>Total</span>
                    <span style={{ fontVariantNumeric: 'tabular-nums' }}>
                      {formatTokens(totalUsage.inputTokens)} in / {formatTokens(totalUsage.outputTokens)} out
                    </span>
                  </div>
                </>
              )}
            </div>
          </CollapsibleSection>
        )}

        {/* Workspace Events (demoted — collapsed by default) */}
        <CollapsibleSection
          title="Events"
          badge={workspaceEvents.length || undefined}
          defaultCollapsed
          storageKey="sam-sidebar-events"
        >
          {workspaceEvents.length === 0 ? (
            <span
              style={{
                fontSize: '0.8125rem',
                color: 'var(--sam-color-fg-muted)',
              }}
            >
              No events yet.
            </span>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {workspaceEvents.map((event) => (
                <div
                  key={event.id}
                  style={{ fontSize: '0.75rem' }}
                >
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      gap: 'var(--sam-space-2)',
                    }}
                  >
                    <strong style={{ color: 'var(--sam-color-fg-primary)' }}>
                      {event.type}
                    </strong>
                    <span style={{ color: 'var(--sam-color-fg-muted)', flexShrink: 0 }}>
                      {new Date(event.createdAt).toLocaleTimeString()}
                    </span>
                  </div>
                  <div style={{ color: 'var(--sam-color-fg-muted)' }}>
                    {event.message}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CollapsibleSection>
      </div>
    </div>
  );
};

// ─── Sub-components ──────────────────────────────────────────

const InfoRow: FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div
    style={{
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'baseline',
      gap: 8,
    }}
  >
    <span
      style={{
        color: 'var(--sam-color-fg-muted)',
        fontSize: '0.75rem',
        flexShrink: 0,
      }}
    >
      {label}
    </span>
    <span
      style={{
        color: 'var(--sam-color-fg-primary)',
        fontSize: '0.8125rem',
        textAlign: 'right',
        minWidth: 0,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </span>
  </div>
);
