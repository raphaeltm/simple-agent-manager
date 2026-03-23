import type { FC, Ref } from 'react';
import { Terminal, MultiTerminal } from '@simple-agent-manager/terminal';
import type {
  MultiTerminalHandle,
  MultiTerminalSessionSnapshot,
} from '@simple-agent-manager/terminal';
import { Button } from '@simple-agent-manager/ui';
import { CenteredStatus } from './WorkspaceControls';

interface WorkspaceTerminalProps {
  wsUrl: string | null;
  resolveWsUrl: () => Promise<string | null>;
  multiTerminal: boolean;
  viewMode: 'terminal' | 'conversation';
  activeWorktree: string | null;
  workspaceId: string | undefined;
  terminalLoading: boolean;
  terminalError: string | null;
  multiTerminalRef: Ref<MultiTerminalHandle>;
  onActivity: () => void;
  onSessionsChange: (
    sessions: MultiTerminalSessionSnapshot[],
    activeSessionId: string | null
  ) => void;
  onRetryConnection: () => void;
}

export const WorkspaceTerminal: FC<WorkspaceTerminalProps> = ({
  wsUrl,
  resolveWsUrl,
  multiTerminal,
  viewMode,
  activeWorktree,
  workspaceId,
  terminalLoading,
  terminalError,
  multiTerminalRef,
  onActivity,
  onSessionsChange,
  onRetryConnection,
}) => (
  <div className="h-full" style={{ display: viewMode === 'terminal' ? 'block' : 'none' }}>
    {wsUrl ? (
      multiTerminal ? (
        <MultiTerminal
          ref={multiTerminalRef}
          wsUrl={wsUrl}
          resolveWsUrl={resolveWsUrl}
          defaultWorkDir={activeWorktree ?? undefined}
          onActivity={onActivity}
          className="h-full"
          persistenceKey={workspaceId ? `sam-terminal-sessions-${workspaceId}` : undefined}
          hideTabBar
          onSessionsChange={onSessionsChange}
        />
      ) : (
        <Terminal
          wsUrl={wsUrl}
          resolveWsUrl={resolveWsUrl}
          onActivity={onActivity}
          className="h-full"
        />
      )
    ) : terminalLoading ? (
      <CenteredStatus
        color="var(--sam-color-info)"
        title="Connecting to Terminal..."
        subtitle="Establishing secure connection"
        loading
      />
    ) : (
      <CenteredStatus
        color="var(--sam-color-danger-fg)"
        title="Connection Failed"
        subtitle={terminalError || 'Unable to connect to terminal'}
        action={
          <Button
            variant="secondary"
            size="sm"
            onClick={onRetryConnection}
            disabled={terminalLoading}
          >
            Retry Connection
          </Button>
        }
      />
    )}
  </div>
);
