import { useState, useEffect, useMemo, type FC } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '@simple-agent-manager/ui';
import { GitBranch, ExternalLink, Play, Trash2 } from 'lucide-react';
import type { AgentSession } from '@simple-agent-manager/shared';
import { CollapsibleSection } from './CollapsibleSection';
import { ResourceBar } from './node/ResourceBar';
import { useNodeSystemInfo } from '../hooks/useNodeSystemInfo';
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
  hostStatus?: string | null;
  viewerCount?: number | null;
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
  onStopSession?: (sessionId: string) => void;

  // Session history (suspended/stopped sessions)
  historySessions?: AgentSession[];
  onResumeSession?: (sessionId: string) => void;
  onDeleteSession?: (sessionId: string) => void;

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

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const k = 1024;
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  const val = bytes / Math.pow(k, i);
  return `${val.toFixed(1)} ${units[i]}`;
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

function sessionStatusColor(status: string, hostStatus?: string | null): string {
  // Use live hostStatus for finer-grained colors when available
  if (hostStatus) {
    switch (hostStatus) {
      case 'prompting':
        return 'var(--sam-color-tn-purple)'; // purple — actively working
      case 'ready':
        return 'var(--sam-color-tn-green)'; // green — ready for prompts
      case 'starting':
        return 'var(--sam-color-tn-yellow)'; // amber — initializing
      case 'idle':
        return 'var(--sam-color-tn-fg-muted)'; // dim — no agent selected
      case 'stopped':
        return 'var(--sam-color-tn-fg-dimmer)'; // dimmer — stopped
      case 'error':
        return 'var(--sam-color-tn-red)'; // red
    }
  }

  switch (status) {
    case 'connected':
    case 'running':
      return 'var(--sam-color-tn-green)';
    case 'connecting':
    case 'reconnecting':
      return 'var(--sam-color-tn-yellow)';
    case 'error':
      return 'var(--sam-color-tn-red)';
    default:
      return 'var(--sam-color-tn-fg-muted)';
  }
}

/** Human-readable label for agent host status */
function hostStatusLabel(hostStatus: string): string {
  switch (hostStatus) {
    case 'prompting':
      return 'working';
    case 'ready':
      return 'ready';
    case 'starting':
      return 'starting';
    case 'idle':
      return 'idle';
    case 'stopped':
      return 'stopped';
    case 'error':
      return 'error';
    default:
      return hostStatus;
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
  onStopSession,
  historySessions = [],
  onResumeSession,
  onDeleteSession,
  gitStatus,
  onOpenGitChanges,
  sessionTokenUsages,
  workspaceEvents,
}) => {
  const uptime = useRelativeTime(workspace?.createdAt);

  // Node resource polling — only when workspace is running
  const { systemInfo, error: systemInfoError } = useNodeSystemInfo(
    workspace?.nodeId ?? undefined,
    isRunning ? 'running' : undefined
  );

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
              fontSize: 'var(--sam-type-caption-size)',
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
          <div style={{ display: 'grid', gap: 6, fontSize: 'var(--sam-type-caption-size)' }}>
            {/* Repository */}
            {workspace?.repository && (
              <InfoRow label="Repository">
                {repoUrl ? (
                  <a
                    href={repoUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{
                      color: 'var(--sam-color-tn-blue)',
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
                    color: 'var(--sam-color-tn-blue)',
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
          </div>
        </CollapsibleSection>

        {/* Node Resources */}
        {isRunning && workspace?.nodeId && (
          <CollapsibleSection
            title="Node Resources"
            defaultCollapsed
            storageKey="sam-sidebar-node-resources"
          >
            {systemInfo ? (
              <div style={{ display: 'grid', gap: 10 }}>
                <ResourceBar
                  label="CPU"
                  percent={Math.min(100, (systemInfo.cpu.loadAvg1 / systemInfo.cpu.numCpu) * 100)}
                  detail={`Load: ${systemInfo.cpu.loadAvg1.toFixed(2)} / ${systemInfo.cpu.numCpu} cores`}
                />
                <ResourceBar
                  label="Memory"
                  percent={systemInfo.memory.usedPercent}
                  detail={`${formatBytes(systemInfo.memory.usedBytes)} / ${formatBytes(systemInfo.memory.totalBytes)}`}
                />
                <ResourceBar
                  label="Disk"
                  percent={systemInfo.disk.usedPercent}
                  detail={`${formatBytes(systemInfo.disk.usedBytes)} / ${formatBytes(systemInfo.disk.totalBytes)}`}
                />
              </div>
            ) : systemInfoError ? (
              <span style={{ fontSize: 'var(--sam-type-caption-size)', color: 'var(--sam-color-fg-muted)' }}>
                Unable to load resource data
              </span>
            ) : (
              <span style={{ fontSize: 'var(--sam-type-caption-size)', color: 'var(--sam-color-fg-muted)' }}>
                Loading...
              </span>
            )}
          </CollapsibleSection>
        )}

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
                const isChat = tab.kind === 'chat';
                const canStop = isChat && onStopSession && tab.status === 'running';
                return (
                  <div
                    key={tab.id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 0,
                      borderRadius: 'var(--sam-radius-sm)',
                      background: active
                        ? 'var(--sam-color-info-tint)'
                        : 'transparent',
                    }}
                  >
                    <button
                      onClick={() => onSelectTab(tab)}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        padding: isMobile ? '8px 6px' : '5px 6px',
                        minHeight: isMobile ? 44 : undefined,
                        borderRadius: 'var(--sam-radius-sm)',
                        border: 'none',
                        background: 'transparent',
                        cursor: 'pointer',
                        flex: 1,
                        minWidth: 0,
                        textAlign: 'left',
                        fontSize: 'var(--sam-type-caption-size)',
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
                          backgroundColor: sessionStatusColor(tab.status, tab.hostStatus),
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
                      {/* Viewer count badge */}
                      {tab.viewerCount != null && tab.viewerCount > 0 && (
                        <span
                          style={{
                            fontSize: 'var(--sam-type-caption-size)',
                            color: 'var(--sam-color-fg-muted)',
                            backgroundColor: 'var(--sam-color-info-tint)',
                            borderRadius: 'var(--sam-radius-sm)',
                            padding: '1px 4px',
                            flexShrink: 0,
                          }}
                          title={`${tab.viewerCount} viewer${tab.viewerCount === 1 ? '' : 's'} connected`}
                        >
                          {tab.viewerCount}
                        </span>
                      )}
                      {/* Host status label */}
                      {isChat && tab.hostStatus && (
                        <span
                          style={{
                            fontSize: 'var(--sam-type-caption-size)',
                            color: sessionStatusColor(tab.status, tab.hostStatus),
                            flexShrink: 0,
                          }}
                        >
                          {hostStatusLabel(tab.hostStatus)}
                        </span>
                      )}
                      {/* Active label for non-chat or when no hostStatus */}
                      {active && !(isChat && tab.hostStatus) && (
                        <span
                          style={{
                            fontSize: 'var(--sam-type-caption-size)',
                            color: 'var(--sam-color-tn-blue)',
                            flexShrink: 0,
                          }}
                        >
                          active
                        </span>
                      )}
                    </button>
                    {/* Stop button for chat sessions */}
                    {canStop && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onStopSession!(tab.sessionId);
                        }}
                        title="Stop session"
                        aria-label={`Stop session ${tab.title}`}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          width: isMobile ? 36 : 24,
                          height: isMobile ? 36 : 24,
                          padding: 0,
                          border: 'none',
                          background: 'transparent',
                          color: 'var(--sam-color-fg-muted)',
                          cursor: 'pointer',
                          borderRadius: 'var(--sam-radius-sm)',
                          flexShrink: 0,
                          marginRight: 2,
                        }}
                      >
                        <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
                          <rect x="2" y="2" width="8" height="8" rx="1" />
                        </svg>
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </CollapsibleSection>
        )}

        {/* Session History (suspended/stopped) */}
        {historySessions.length > 0 && (
          <CollapsibleSection
            title="Session History"
            badge={historySessions.length}
            defaultCollapsed
            storageKey="sam-sidebar-session-history"
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {historySessions.map((session) => (
                <div
                  key={session.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 0,
                    padding: isMobile ? '8px 6px' : '5px 6px',
                    borderRadius: 'var(--sam-radius-sm)',
                    background: 'var(--sam-color-bg-inset)',
                    minHeight: isMobile ? 44 : undefined,
                  }}
                >
                  {/* Status dot */}
                  <span
                    style={{
                      display: 'inline-block',
                      width: 7,
                      height: 7,
                      borderRadius: '50%',
                      backgroundColor:
                        session.status === 'suspended'
                          ? 'var(--sam-color-tn-yellow)'
                          : 'var(--sam-color-tn-fg-dimmer)',
                      flexShrink: 0,
                      marginRight: 8,
                    }}
                  />
                  {/* Label + last prompt */}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: 'var(--sam-type-caption-size)',
                        color: 'var(--sam-color-fg-primary)',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {session.label || `Chat ${session.id.slice(-6)}`}
                    </div>
                    {session.lastPrompt && (
                      <div
                        style={{
                          fontSize: '10px',
                          color: 'var(--sam-color-fg-muted)',
                          marginTop: 1,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                        title={session.lastPrompt}
                      >
                        {session.lastPrompt}
                      </div>
                    )}
                    <div
                      style={{
                        fontSize: '10px',
                        color: 'var(--sam-color-fg-muted)',
                        marginTop: 1,
                      }}
                    >
                      {session.status === 'suspended' ? 'suspended' : 'stopped'}
                      {session.suspendedAt &&
                        ` \u00B7 ${new Date(session.suspendedAt).toLocaleTimeString()}`}
                      {!session.suspendedAt &&
                        session.stoppedAt &&
                        ` \u00B7 ${new Date(session.stoppedAt).toLocaleTimeString()}`}
                    </div>
                  </div>
                  {/* Action buttons */}
                  <div style={{ display: 'flex', gap: 2, flexShrink: 0, marginLeft: 4 }}>
                    {session.status === 'suspended' && onResumeSession && (
                      <button
                        onClick={() => onResumeSession(session.id)}
                        title="Resume session"
                        aria-label={`Resume session ${session.label || session.id}`}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          width: isMobile ? 36 : 24,
                          height: isMobile ? 36 : 24,
                          padding: 0,
                          border: 'none',
                          background: 'transparent',
                          color: 'var(--sam-color-tn-green)',
                          cursor: 'pointer',
                          borderRadius: 'var(--sam-radius-sm)',
                        }}
                      >
                        <Play size={12} />
                      </button>
                    )}
                    {onDeleteSession && (
                      <button
                        onClick={() => onDeleteSession(session.id)}
                        title="Delete session"
                        aria-label={`Delete session ${session.label || session.id}`}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          width: isMobile ? 36 : 24,
                          height: isMobile ? 36 : 24,
                          padding: 0,
                          border: 'none',
                          background: 'transparent',
                          color: 'var(--sam-color-fg-muted)',
                          cursor: 'pointer',
                          borderRadius: 'var(--sam-radius-sm)',
                        }}
                      >
                        <Trash2 size={12} />
                      </button>
                    )}
                  </div>
                </div>
              ))}
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
                    fontSize: 'var(--sam-type-caption-size)',
                    color: 'var(--sam-color-fg-muted)',
                  }}
                >
                  <span>
                    <strong style={{ color: 'var(--sam-color-tn-green)' }}>{gitStatus.staged.length}</strong> staged
                  </span>
                  <span>
                    <strong style={{ color: 'var(--sam-color-tn-yellow)' }}>{gitStatus.unstaged.length}</strong> unstaged
                  </span>
                  <span>
                    <strong style={{ color: 'var(--sam-color-tn-fg-muted)' }}>{gitStatus.untracked.length}</strong> untracked
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
                    color: 'var(--sam-color-tn-blue)',
                    fontSize: 'var(--sam-type-caption-size)',
                    textAlign: 'left',
                  }}
                >
                  <GitBranch size={12} />
                  View Changes
                </button>
              </div>
            ) : (
              <span style={{ fontSize: 'var(--sam-type-caption-size)', color: 'var(--sam-color-fg-muted)' }}>
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
                fontSize: 'var(--sam-type-caption-size)',
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
                fontSize: 'var(--sam-type-caption-size)',
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
                  style={{ fontSize: 'var(--sam-type-caption-size)' }}
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
        fontSize: 'var(--sam-type-caption-size)',
        flexShrink: 0,
      }}
    >
      {label}
    </span>
    <span
      style={{
        color: 'var(--sam-color-fg-primary)',
        fontSize: 'var(--sam-type-caption-size)',
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
