import type { AgentSession } from '@simple-agent-manager/shared';
import { Play, Trash2 } from 'lucide-react';

import { CollapsibleSection } from './CollapsibleSection';

export interface SidebarTab {
  id: string;
  kind: 'terminal' | 'chat';
  sessionId: string;
  title: string;
  status: string;
  hostStatus?: string | null;
  viewerCount?: number | null;
}

function sessionStatusColor(status: string, hostStatus?: string | null): string {
  if (hostStatus) {
    const colors: Record<string, string> = {
      prompting: 'var(--sam-workspace-purple-fg)',
      ready: 'var(--sam-workspace-success-fg)',
      starting: 'var(--sam-workspace-warning-fg)',
      idle: 'var(--sam-workspace-tab-muted)',
      stopped: 'var(--sam-workspace-muted-dot)',
      error: 'var(--sam-workspace-danger-fg)',
    };
    if (colors[hostStatus]) return colors[hostStatus];
  }
  if (status === 'connected' || status === 'running') return 'var(--sam-workspace-success-fg)';
  if (status === 'connecting' || status === 'reconnecting')
    return 'var(--sam-workspace-warning-fg)';
  if (status === 'error') return 'var(--sam-workspace-danger-fg)';
  return 'var(--sam-workspace-tab-muted)';
}

function hostStatusLabel(status: string): string {
  return status === 'prompting' ? 'working' : status;
}

export function WorkspaceSidebarSessions({
  workspaceTabs,
  activeTabId,
  onSelectTab,
  onStopSession,
  historySessions,
  onResumeSession,
  onDeleteSession,
  isMobile,
}: Readonly<{
  workspaceTabs: SidebarTab[];
  activeTabId: string | null;
  onSelectTab: (tab: SidebarTab) => void;
  onStopSession?: (sessionId: string) => void;
  historySessions: AgentSession[];
  onResumeSession?: (sessionId: string) => void;
  onDeleteSession?: (sessionId: string) => void;
  isMobile: boolean;
}>) {
  return (
    <>
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
                  style={{ background: active ? 'var(--sam-color-info-tint)' : 'transparent' }}
                >
                  <button
                    onClick={() => onSelectTab(tab)}
                    className="flex items-center gap-2 rounded-sm border-none bg-transparent cursor-pointer flex-1 min-w-0 text-left"
                    style={{
                      padding: isMobile ? '8px 6px' : '5px 6px',
                      minHeight: isMobile ? 44 : undefined,
                      fontSize: 'var(--sam-type-caption-size)',
                      color: active ? 'var(--sam-color-fg-primary)' : 'var(--sam-color-fg-muted)',
                    }}
                  >
                    <span
                      className="inline-block w-[7px] h-[7px] rounded-full shrink-0"
                      style={{ backgroundColor: sessionStatusColor(tab.status, tab.hostStatus) }}
                    />
                    <span className="flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
                      {tab.title}
                    </span>
                    {tab.viewerCount != null && tab.viewerCount > 0 && (
                      <span className="text-fg-muted bg-info-tint rounded-sm shrink-0 px-1 text-xs">
                        {tab.viewerCount}
                      </span>
                    )}
                    {isChat && tab.hostStatus && (
                      <span
                        className="shrink-0 text-xs"
                        style={{ color: sessionStatusColor(tab.status, tab.hostStatus) }}
                      >
                        {hostStatusLabel(tab.hostStatus)}
                      </span>
                    )}
                    {active && !(isChat && tab.hostStatus) && (
                      <span className="shrink-0 text-xs text-info">active</span>
                    )}
                  </button>
                  {canStop && (
                    <button
                      onClick={(event) => {
                        event.stopPropagation();
                        onStopSession?.(tab.sessionId);
                      }}
                      title="Stop session"
                      aria-label={`Stop session ${tab.title}`}
                      className="flex items-center justify-center p-0 border-none bg-transparent text-fg-muted cursor-pointer rounded-sm shrink-0 mr-0.5"
                      style={{ width: isMobile ? 36 : 24, height: isMobile ? 36 : 24 }}
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
                style={{ padding: isMobile ? '8px 6px' : '5px 6px' }}
              >
                <span
                  className="inline-block w-[7px] h-[7px] rounded-full shrink-0 mr-2"
                  style={{
                    backgroundColor:
                      session.status === 'suspended'
                        ? 'var(--sam-workspace-warning-fg)'
                        : 'var(--sam-workspace-muted-dot)',
                  }}
                />
                <div className="flex-1 min-w-0">
                  <div className="text-fg-primary truncate text-xs">
                    {session.label || `Chat ${session.id.slice(-6)}`}
                  </div>
                  {session.lastPrompt && (
                    <div
                      className="text-fg-muted mt-px truncate text-[10px]"
                      title={session.lastPrompt}
                    >
                      {session.lastPrompt}
                    </div>
                  )}
                  <div className="text-fg-muted mt-px text-[10px]">
                    {session.status === 'suspended' ? 'suspended' : 'stopped'}
                  </div>
                </div>
                <div className="flex gap-0.5 shrink-0 ml-1">
                  {session.status === 'suspended' && onResumeSession && (
                    <button
                      onClick={() => onResumeSession(session.id)}
                      title="Resume session"
                      aria-label={`Resume session ${session.label || session.id}`}
                      className="flex items-center justify-center p-0 border-none bg-transparent cursor-pointer rounded-sm text-success"
                      style={{ width: isMobile ? 36 : 24, height: isMobile ? 36 : 24 }}
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
                      style={{ width: isMobile ? 36 : 24, height: isMobile ? 36 : 24 }}
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
    </>
  );
}
