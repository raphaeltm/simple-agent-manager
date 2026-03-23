import type { FC, ReactNode } from 'react';
import { Button, Spinner } from '@simple-agent-manager/ui';
import type { BootLogEntry, WorkspaceResponse } from '@simple-agent-manager/shared';

// ─── Toolbar ──────────────────────────────────────────────────

interface ToolbarProps {
  onBack: () => void;
}

export const Toolbar: FC<ToolbarProps> = ({ onBack }) => (
  <header className="flex items-center px-3 h-10 bg-surface border-b border-border-default gap-2.5 shrink-0">
    <button
      onClick={onBack}
      className="bg-transparent border-none cursor-pointer text-fg-muted p-1 flex"
    >
      <svg
        style={{ height: 16, width: 16 }}
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
      >
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
      </svg>
    </button>
    <span
      className="font-semibold text-fg-primary"
      style={{ fontSize: 'var(--sam-type-secondary-size)' }}
    >
      Workspace
    </span>
  </header>
);

// ─── CenteredStatus ───────────────────────────────────────────

interface CenteredStatusProps {
  color: string;
  title: string;
  subtitle?: string | null;
  action?: ReactNode;
  loading?: boolean;
}

export const CenteredStatus: FC<CenteredStatusProps> = ({
  color,
  title,
  subtitle,
  action,
  loading: isLoading,
}) => (
  <div className="flex flex-col items-center justify-center h-full gap-3 bg-tn-bg text-tn-fg">
    {isLoading && <Spinner size="lg" />}
    <h3
      className="font-semibold m-0"
      style={{ fontSize: 'var(--sam-type-card-title-size)', color }}
    >
      {title}
    </h3>
    {subtitle && (
      <p
        className="m-0 max-w-[400px] text-center text-tn-fg-muted"
        style={{ fontSize: 'var(--sam-type-secondary-size)' }}
      >
        {subtitle}
      </p>
    )}
    {action && <div className="mt-1">{action}</div>}
  </div>
);

// ─── BootProgress ─────────────────────────────────────────────

interface BootProgressProps {
  logs?: BootLogEntry[];
}

export const BootProgress: FC<BootProgressProps> = ({ logs }) => {
  if (!logs || logs.length === 0) {
    return (
      <CenteredStatus
        color="var(--sam-color-info)"
        title="Creating Workspace"
        subtitle="Initializing..."
        loading
      />
    );
  }

  // Deduplicate: show latest status per step
  const stepMap = new Map<string, BootLogEntry>();
  for (const log of logs) {
    stepMap.set(log.step, log);
  }
  const steps = Array.from(stepMap.values());

  const statusIcon = (status: BootLogEntry['status']) => {
    switch (status) {
      case 'completed':
        return (
          <span
            className="text-success-fg mr-2"
            style={{ fontSize: 'var(--sam-type-secondary-size)' }}
          >
            &#10003;
          </span>
        );
      case 'failed':
        return (
          <span
            className="text-danger-fg mr-2"
            style={{ fontSize: 'var(--sam-type-secondary-size)' }}
          >
            &#10007;
          </span>
        );
      case 'started':
      default:
        return (
          <span className="mr-2 inline-flex">
            <Spinner size="sm" />
          </span>
        );
    }
  };

  const lastStep = steps[steps.length - 1];
  const hasFailed = lastStep?.status === 'failed';

  return (
    <div className="flex flex-col items-center justify-center h-full bg-tn-bg text-tn-fg p-6">
      <h3
        className="font-semibold mb-4"
        style={{
          fontSize: 'var(--sam-type-card-title-size)',
          color: hasFailed ? 'var(--sam-color-danger-fg)' : 'var(--sam-color-info)',
        }}
      >
        {hasFailed ? 'Provisioning Failed' : 'Creating Workspace'}
      </h3>
      <div className="flex flex-col gap-1.5 max-w-[400px] w-full">
        {steps.map((entry, i) => (
          <div
            key={i}
            className="flex items-center"
            style={{
              fontSize: 'var(--sam-type-caption-size)',
              color:
                entry.status === 'failed'
                  ? 'var(--sam-color-danger-fg)'
                  : entry.status === 'completed'
                    ? 'var(--sam-color-tn-fg-muted)'
                    : 'var(--sam-color-tn-fg)',
            }}
          >
            {statusIcon(entry.status)}
            <span>{entry.message}</span>
          </div>
        ))}
      </div>
      {lastStep?.status === 'failed' && lastStep.detail && (
        <p
          className="mt-3 mb-0 max-w-[400px] text-center break-words text-tn-fg-muted"
          style={{ fontSize: 'var(--sam-type-caption-size)' }}
        >
          {lastStep.detail}
        </p>
      )}
    </div>
  );
};

// ─── WorkspaceStatusContent ───────────────────────────────────
// Renders the appropriate non-running state view for the workspace.

interface WorkspaceStatusContentProps {
  workspace: WorkspaceResponse | null;
  bootLogs: BootLogEntry[];
  actionLoading: boolean;
  onRestart: () => void;
  onRebuild: () => void;
}

export const WorkspaceStatusContent: FC<WorkspaceStatusContentProps> = ({
  workspace,
  bootLogs,
  actionLoading,
  onRestart,
  onRebuild,
}) => {
  if (workspace?.status === 'creating') {
    return <BootProgress logs={bootLogs.length > 0 ? bootLogs : workspace.bootLogs} />;
  }

  if (workspace?.status === 'stopping') {
    return (
      <CenteredStatus color="var(--sam-color-warning-fg)" title="Stopping Workspace" loading />
    );
  }

  if (workspace?.status === 'stopped') {
    return (
      <CenteredStatus
        color="var(--sam-color-fg-muted)"
        title="Workspace Stopped"
        subtitle="Restart to access the terminal."
        action={
          <Button
            variant="primary"
            size="sm"
            onClick={onRestart}
            disabled={actionLoading}
            loading={actionLoading}
          >
            Restart Workspace
          </Button>
        }
      />
    );
  }

  if (workspace?.status === 'error') {
    return (
      <CenteredStatus
        color="var(--sam-color-danger-fg)"
        title="Workspace Error"
        subtitle={workspace?.errorMessage || 'An unexpected error occurred.'}
        action={
          <div className="flex gap-2 flex-wrap justify-center">
            <Button
              variant="primary"
              size="sm"
              onClick={onRebuild}
              disabled={actionLoading}
              loading={actionLoading}
            >
              Rebuild Container
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={onRestart}
              disabled={actionLoading}
              loading={actionLoading}
            >
              Restart Workspace
            </Button>
          </div>
        }
      />
    );
  }

  return null;
};
