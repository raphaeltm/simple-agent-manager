import type { TokenUsage } from '@simple-agent-manager/acp-client';
import type {
  AgentSession,
  DetectedPort,
  Event,
  WorkspaceResponse,
} from '@simple-agent-manager/shared';
import { Button } from '@simple-agent-manager/ui';
import { GitBranch } from 'lucide-react';
import { type FC, useMemo } from 'react';

import type { GitStatusData } from '../lib/api';
import { CollapsibleSection } from './CollapsibleSection';
import { WorkspaceSidebarInfrastructure } from './WorkspaceSidebarInfrastructure';
import { type SidebarTab, WorkspaceSidebarSessions } from './WorkspaceSidebarSessions';

export type { SidebarTab } from './WorkspaceSidebarSessions';

export interface SessionTokenUsage {
  sessionId: string;
  label: string;
  usage: TokenUsage;
}

interface WorkspaceSidebarProps {
  workspace: WorkspaceResponse | null;
  isRunning: boolean;
  isMobile: boolean;
  actionLoading: boolean;
  onStop: () => void;
  onRestart: () => void;
  onRebuild: () => void;
  displayNameInput: string;
  onDisplayNameChange: (value: string) => void;
  onRename: () => void;
  renaming: boolean;
  workspaceTabs: SidebarTab[];
  activeTabId: string | null;
  onSelectTab: (tab: SidebarTab) => void;
  onStopSession?: (sessionId: string) => void;
  historySessions?: AgentSession[];
  onResumeSession?: (sessionId: string) => void;
  onDeleteSession?: (sessionId: string) => void;
  gitStatus: GitStatusData | null;
  onOpenGitChanges: () => void;
  sessionTokenUsages: SessionTokenUsage[];
  detectedPorts: DetectedPort[];
  workspaceEvents: Event[];
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(value);
}

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
  const gitTotal = gitStatus
    ? gitStatus.staged.length + gitStatus.unstaged.length + gitStatus.untracked.length
    : 0;
  const totalUsage = useMemo(() => {
    const totals = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    for (const session of sessionTokenUsages) {
      totals.inputTokens += session.usage.inputTokens;
      totals.outputTokens += session.usage.outputTokens;
      totals.totalTokens += session.usage.totalTokens;
    }
    return totals;
  }, [sessionTokenUsages]);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div
        className="flex flex-col gap-2 shrink-0 border-b border-border-default"
        style={{ padding: '10px 12px' }}
      >
        <div className="flex" style={{ gap: 'var(--sam-space-2)' }}>
          <input
            value={displayNameInput}
            onChange={(event) => onDisplayNameChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') onRename();
            }}
            placeholder="Workspace name"
            className="flex-1 rounded-sm border border-border-default bg-canvas text-fg-primary min-w-0"
            style={{ padding: '5px 8px', fontSize: 'var(--sam-type-caption-size)' }}
          />
          <Button size="sm" onClick={onRename} disabled={renaming || !displayNameInput.trim()}>
            {renaming ? 'Saving...' : 'Rename'}
          </Button>
        </div>

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

      <div className="flex-1 overflow-auto min-w-0">
        <WorkspaceSidebarInfrastructure
          workspace={workspace}
          isRunning={isRunning}
          detectedPorts={detectedPorts}
        />
        <WorkspaceSidebarSessions
          workspaceTabs={workspaceTabs}
          activeTabId={activeTabId}
          onSelectTab={onSelectTab}
          onStopSession={onStopSession}
          historySessions={historySessions}
          onResumeSession={onResumeSession}
          onDeleteSession={onDeleteSession}
          isMobile={isMobile}
        />

        {isRunning && (
          <CollapsibleSection
            title="Git Changes"
            badge={gitTotal || undefined}
            storageKey="sam-sidebar-git"
          >
            {gitStatus ? (
              <div className="flex flex-col gap-2">
                <div className="flex gap-3 text-fg-muted text-xs flex-wrap">
                  <span>
                    <strong style={{ color: 'var(--sam-workspace-success-fg)' }}>
                      {gitStatus.staged.length}
                    </strong>{' '}
                    staged
                  </span>
                  <span>
                    <strong style={{ color: 'var(--sam-workspace-warning-fg)' }}>
                      {gitStatus.unstaged.length}
                    </strong>{' '}
                    unstaged
                  </span>
                  <span>
                    <strong className="text-fg-muted">{gitStatus.untracked.length}</strong>{' '}
                    untracked
                  </span>
                </div>
                <button
                  onClick={onOpenGitChanges}
                  className="inline-flex items-center gap-1.5 py-1 px-0 bg-transparent border-none cursor-pointer text-left text-xs"
                  style={{ color: 'var(--sam-workspace-link-fg)' }}
                >
                  <GitBranch size={12} />
                  View Changes
                </button>
              </div>
            ) : (
              <span className="text-fg-muted text-xs">Loading...</span>
            )}
          </CollapsibleSection>
        )}

        {sessionTokenUsages.length > 0 && totalUsage.totalTokens > 0 && (
          <CollapsibleSection title="Token Usage" storageKey="sam-sidebar-tokens">
            <div className="flex flex-col gap-1.5 text-xs min-w-0">
              {sessionTokenUsages
                .filter((session) => session.usage.totalTokens > 0)
                .map((session) => (
                  <div
                    key={session.sessionId}
                    className="flex justify-between text-fg-muted min-w-0"
                  >
                    <span className="truncate min-w-0 flex-1">{session.label}</span>
                    <span className="shrink-0 ml-2 tabular-nums">
                      {formatTokens(session.usage.inputTokens)} in /{' '}
                      {formatTokens(session.usage.outputTokens)} out
                    </span>
                  </div>
                ))}
              {sessionTokenUsages.filter((session) => session.usage.totalTokens > 0).length > 1 && (
                <div className="border-t border-border-default pt-1 flex justify-between font-semibold text-fg-primary">
                  <span>Total</span>
                  <span className="tabular-nums">
                    {formatTokens(totalUsage.inputTokens)} in /{' '}
                    {formatTokens(totalUsage.outputTokens)} out
                  </span>
                </div>
              )}
            </div>
          </CollapsibleSection>
        )}

        <CollapsibleSection
          title="Events"
          badge={workspaceEvents.length || undefined}
          defaultCollapsed
          storageKey="sam-sidebar-events"
        >
          {workspaceEvents.length === 0 ? (
            <span className="text-fg-muted text-xs">No events yet.</span>
          ) : (
            <div className="flex flex-col gap-1.5 min-w-0">
              {workspaceEvents.map((event) => (
                <div key={event.id} className="text-xs min-w-0">
                  <div className="flex justify-between gap-2">
                    <strong className="text-fg-primary break-words min-w-0">{event.type}</strong>
                    <span className="text-fg-muted shrink-0">
                      {new Date(event.createdAt).toLocaleTimeString()}
                    </span>
                  </div>
                  <div className="text-fg-muted break-words">{event.message}</div>
                </div>
              ))}
            </div>
          )}
        </CollapsibleSection>
      </div>
    </div>
  );
};
