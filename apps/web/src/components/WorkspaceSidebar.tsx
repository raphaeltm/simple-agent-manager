import type { TokenUsage } from '@simple-agent-manager/acp-client';
import type { AgentSession } from '@simple-agent-manager/shared';
import type { DetectedPort,Event, WorkspaceResponse } from '@simple-agent-manager/shared';
import { VM_LOCATIONS,VM_SIZE_LABELS } from '@simple-agent-manager/shared';
import { Button } from '@simple-agent-manager/ui';
import { ExternalLink, GitBranch, Globe,Play, Trash2 } from 'lucide-react';
import { type FC,useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';

import { useNodeSystemInfo } from '../hooks/useNodeSystemInfo';
import type { GitStatusData } from '../lib/api';
import { BrowserSidecar } from './BrowserSidecar';
import { CollapsibleSection } from './CollapsibleSection';
import { ResourceBar } from './node/ResourceBar';

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

  // Detected ports
  detectedPorts: DetectedPort[];

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

// VM display helpers using shared provider-agnostic constants
function vmSizeLabel(size: string): string {
  const config = VM_SIZE_LABELS[size as keyof typeof VM_SIZE_LABELS];
  return config ? `${config.label} (${config.shortDescription})` : size;
}

function vmLocationLabel(location: string): string {
  const config = VM_LOCATIONS[location];
  return config ? `${config.name}, ${config.country}` : location;
}

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
  detectedPorts,
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
    <div className="flex flex-col h-full overflow-hidden">
      {/* ── Header: name + lifecycle ── */}
      <div className="flex flex-col gap-2 shrink-0 border-b border-border-default" style={{ padding: '10px 12px' }}>
        <div className="flex" style={{ gap: 'var(--sam-space-2)' }}>
          <input
            value={displayNameInput}
            onChange={(event) => onDisplayNameChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') onRename();
            }}
            placeholder="Workspace name"
            aria-label="Workspace name"
            className="flex-1 rounded-sm border border-border-default bg-canvas text-fg-primary min-w-0"
            style={{
              padding: '5px 8px',
              fontSize: 'var(--sam-type-caption-size)',
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
        <div className="flex" style={{ gap: 'var(--sam-space-2)' }}>
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
      <div className="flex-1 overflow-auto">
        {/* Workspace Info */}
        <CollapsibleSection
          title="Workspace Info"
          storageKey="sam-sidebar-workspace-info"
        >
          <div className="grid gap-1.5" style={{ fontSize: 'var(--sam-type-caption-size)' }}>
            {/* Repository */}
            {workspace?.repository && (
              <InfoRow label="Repository">
                {repoUrl ? (
                  <a
                    href={repoUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-tn-blue no-underline inline-flex items-center gap-1"
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
                <span className="inline-flex items-center gap-1">
                  <GitBranch size={12} className="text-fg-muted" />
                  {workspace.branch}
                </span>
              </InfoRow>
            )}

            {/* VM */}
            {workspace?.vmSize && (
              <InfoRow label="VM">
                {vmSizeLabel(workspace.vmSize)}
                {workspace.vmLocation
                  ? ` \u00B7 ${vmLocationLabel(workspace.vmLocation)}`
                  : ''}
              </InfoRow>
            )}

            {/* Node */}
            {workspace?.nodeId && (
              <InfoRow label="Node">
                <Link
                  to={`/nodes/${workspace.nodeId}`}
                  className="text-tn-blue no-underline inline-flex items-center gap-1"
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
              <div className="grid gap-2.5">
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
              <span className="text-fg-muted" style={{ fontSize: 'var(--sam-type-caption-size)' }}>
                Unable to load resource data
              </span>
            ) : (
              <span className="text-fg-muted" style={{ fontSize: 'var(--sam-type-caption-size)' }}>
                Loading...
              </span>
            )}
          </CollapsibleSection>
        )}

        {/* Active Ports */}
        {isRunning && detectedPorts.length > 0 && (
          <CollapsibleSection
            title="Active Ports"
            badge={detectedPorts.length}
            storageKey="sam-sidebar-active-ports"
          >
            <div className="flex flex-col gap-1">
              {detectedPorts
                .slice()
                .sort((a, b) => a.port - b.port)
                .map((p) => (
                  <a
                    key={p.port}
                    href={p.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={`Open port ${p.port} (${p.label})`}
                    className="flex items-center gap-2 rounded-sm px-2 py-1.5 text-fg-primary hover:bg-surface-hover transition-colors"
                    style={{ fontSize: 'var(--sam-type-caption-size)' }}
                  >
                    <Globe className="w-3.5 h-3.5 text-fg-muted flex-shrink-0" />
                    <span className="font-mono font-medium">{p.port}</span>
                    <span className="text-fg-muted truncate">{p.label}</span>
                    {p.address === '127.0.0.1' && (
                      <span className="text-fg-muted ml-auto text-xs">(local)</span>
                    )}
                    <ExternalLink className="w-3 h-3 text-fg-muted ml-auto flex-shrink-0" />
                  </a>
                ))}
            </div>
          </CollapsibleSection>
        )}

        {/* Remote Browser */}
        {isRunning && workspace?.id && (
          <CollapsibleSection
            title="Remote Browser"
            defaultCollapsed
            storageKey="sam-sidebar-browser"
          >
            <BrowserSidecar workspaceId={workspace.id} />
          </CollapsibleSection>
        )}

        {/* Sessions */}
        {workspaceTabs.length > 0 && (
          <CollapsibleSection
            title="Sessions"
            badge={workspaceTabs.length}
            storageKey="sam-sidebar-sessions"
          >
            <div className="flex flex-col gap-0.5">
              {workspaceTabs.map((tab) => {
                const active = activeTabId === tab.id;
                const isChat = tab.kind === 'chat';
                const canStop = isChat && onStopSession && tab.status === 'running';
                return (
                  <div
                    key={tab.id}
                    className="flex items-center gap-0 rounded-sm"
                    style={{
                      background: active
                        ? 'var(--sam-color-info-tint)'
                        : 'transparent',
                    }}
                  >
                    <button
                      onClick={() => onSelectTab(tab)}
                      className="flex items-center gap-2 rounded-sm border-none bg-transparent cursor-pointer flex-1 min-w-0 text-left"
                      style={{
                        padding: isMobile ? '8px 6px' : '5px 6px',
                        minHeight: isMobile ? 44 : undefined,
                        fontSize: 'var(--sam-type-caption-size)',
                        color: active
                          ? 'var(--sam-color-fg-primary)'
                          : 'var(--sam-color-fg-muted)',
                      }}
                    >
                      <span
                        className="inline-block w-[7px] h-[7px] rounded-full shrink-0"
                        style={{ backgroundColor: sessionStatusColor(tab.status, tab.hostStatus) }}
                      />
                      <span className="flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
                        {tab.title}
                      </span>
                      {/* Viewer count badge */}
                      {tab.viewerCount != null && tab.viewerCount > 0 && (
                        <span
                          className="text-fg-muted bg-info-tint rounded-sm shrink-0"
                          style={{ fontSize: 'var(--sam-type-caption-size)', padding: '1px 4px' }}
                          title={`${tab.viewerCount} viewer${tab.viewerCount === 1 ? '' : 's'} connected`}
                        >
                          {tab.viewerCount}
                        </span>
                      )}
                      {/* Host status label */}
                      {isChat && tab.hostStatus && (
                        <span
                          className="shrink-0"
                          style={{
                            fontSize: 'var(--sam-type-caption-size)',
                            color: sessionStatusColor(tab.status, tab.hostStatus),
                          }}
                        >
                          {hostStatusLabel(tab.hostStatus)}
                        </span>
                      )}
                      {/* Active label for non-chat or when no hostStatus */}
                      {active && !(isChat && tab.hostStatus) && (
                        <span
                          className="text-tn-blue shrink-0"
                          style={{ fontSize: 'var(--sam-type-caption-size)' }}
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
                        className="flex items-center justify-center p-0 border-none bg-transparent text-fg-muted cursor-pointer rounded-sm shrink-0 mr-0.5"
                        style={{
                          width: isMobile ? 36 : 24,
                          height: isMobile ? 36 : 24,
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
            <div className="flex flex-col gap-1">
              {historySessions.map((session) => (
                <div
                  key={session.id}
                  className="flex items-center gap-0 rounded-sm bg-inset"
                  style={{
                    padding: isMobile ? '8px 6px' : '5px 6px',
                    minHeight: isMobile ? 44 : undefined,
                  }}
                >
                  {/* Status dot */}
                  <span
                    className="inline-block w-[7px] h-[7px] rounded-full shrink-0 mr-2"
                    style={{
                      backgroundColor:
                        session.status === 'suspended'
                          ? 'var(--sam-color-tn-yellow)'
                          : 'var(--sam-color-tn-fg-dimmer)',
                    }}
                  />
                  {/* Label + last prompt */}
                  <div className="flex-1 min-w-0">
                    <div
                      className="text-fg-primary overflow-hidden text-ellipsis whitespace-nowrap"
                      style={{ fontSize: 'var(--sam-type-caption-size)' }}
                    >
                      {session.label || `Chat ${session.id.slice(-6)}`}
                    </div>
                    {session.lastPrompt && (
                      <div
                        className="text-fg-muted mt-px overflow-hidden text-ellipsis whitespace-nowrap"
                        style={{ fontSize: '10px' }}
                        title={session.lastPrompt}
                      >
                        {session.lastPrompt}
                      </div>
                    )}
                    <div
                      className="text-fg-muted mt-px"
                      style={{ fontSize: '10px' }}
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
                  <div className="flex gap-0.5 shrink-0 ml-1">
                    {session.status === 'suspended' && onResumeSession && (
                      <button
                        onClick={() => onResumeSession(session.id)}
                        title="Resume session"
                        aria-label={`Resume session ${session.label || session.id}`}
                        className="flex items-center justify-center p-0 border-none bg-transparent text-tn-green cursor-pointer rounded-sm"
                        style={{
                          width: isMobile ? 36 : 24,
                          height: isMobile ? 36 : 24,
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
                        className="flex items-center justify-center p-0 border-none bg-transparent text-fg-muted cursor-pointer rounded-sm"
                        style={{
                          width: isMobile ? 36 : 24,
                          height: isMobile ? 36 : 24,
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
              <div className="flex flex-col gap-2">
                <div
                  className="flex gap-3 text-fg-muted"
                  style={{ fontSize: 'var(--sam-type-caption-size)' }}
                >
                  <span>
                    <strong className="text-tn-green">{gitStatus.staged.length}</strong> staged
                  </span>
                  <span>
                    <strong className="text-tn-yellow">{gitStatus.unstaged.length}</strong> unstaged
                  </span>
                  <span>
                    <strong className="text-tn-fg-muted">{gitStatus.untracked.length}</strong> untracked
                  </span>
                </div>
                <button
                  onClick={onOpenGitChanges}
                  className="inline-flex items-center gap-1.5 py-1 px-0 bg-transparent border-none cursor-pointer text-tn-blue text-left"
                  style={{ fontSize: 'var(--sam-type-caption-size)' }}
                >
                  <GitBranch size={12} />
                  View Changes
                </button>
              </div>
            ) : (
              <span className="text-fg-muted" style={{ fontSize: 'var(--sam-type-caption-size)' }}>
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
              className="flex flex-col gap-1.5"
              style={{ fontSize: 'var(--sam-type-caption-size)' }}
            >
              {sessionTokenUsages
                .filter((s) => s.usage.totalTokens > 0)
                .map((s) => (
                  <div
                    key={s.sessionId}
                    className="flex justify-between text-fg-muted"
                  >
                    <span className="overflow-hidden text-ellipsis whitespace-nowrap min-w-0 flex-1">
                      {s.label}
                    </span>
                    <span className="shrink-0 ml-2" style={{ fontVariantNumeric: 'tabular-nums' }}>
                      {formatTokens(s.usage.inputTokens)} in / {formatTokens(s.usage.outputTokens)} out
                    </span>
                  </div>
                ))}
              {sessionTokenUsages.filter((s) => s.usage.totalTokens > 0).length > 1 && (
                <>
                  <div className="border-t border-border-default pt-1 flex justify-between font-semibold text-fg-primary">
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
            <span className="text-fg-muted" style={{ fontSize: 'var(--sam-type-caption-size)' }}>
              No events yet.
            </span>
          ) : (
            <div className="flex flex-col gap-1.5">
              {workspaceEvents.map((event) => (
                <div
                  key={event.id}
                  style={{ fontSize: 'var(--sam-type-caption-size)' }}
                >
                  <div className="flex justify-between" style={{ gap: 'var(--sam-space-2)' }}>
                    <strong className="text-fg-primary">
                      {event.type}
                    </strong>
                    <span className="text-fg-muted shrink-0">
                      {new Date(event.createdAt).toLocaleTimeString()}
                    </span>
                  </div>
                  <div className="text-fg-muted">
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
  <div className="flex justify-between items-baseline gap-2">
    <span className="text-fg-muted shrink-0" style={{ fontSize: 'var(--sam-type-caption-size)' }}>
      {label}
    </span>
    <span
      className="text-fg-primary text-right min-w-0 overflow-hidden text-ellipsis whitespace-nowrap"
      style={{ fontSize: 'var(--sam-type-caption-size)' }}
    >
      {children}
    </span>
  </div>
);
