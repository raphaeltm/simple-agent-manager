import type { BootLogEntry } from '@simple-agent-manager/shared';
import { Spinner } from '@simple-agent-manager/ui';

import { BootLogList } from '../../components/shared/BootLogList';

export function MinimalToolbar({ onBack }: { onBack: () => void }) {
  return (
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
      <span className="font-semibold text-fg-primary" style={{ fontSize: 'var(--sam-type-secondary-size)' }}>
        Workspace
      </span>
    </header>
  );
}

export function CenteredStatus({
  color,
  title,
  subtitle,
  action,
  loading: isLoading,
}: {
  color: string;
  title: string;
  subtitle?: string | null;
  action?: React.ReactNode;
  loading?: boolean;
}) {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-3 bg-tn-bg text-tn-fg">
      {isLoading && <Spinner size="lg" />}
      <h3 className="font-semibold m-0" style={{ fontSize: 'var(--sam-type-card-title-size)', color }}>{title}</h3>
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
}

export function BootProgress({ logs }: { logs?: BootLogEntry[] }) {
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

  const lastStep = logs[logs.length - 1];
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
      <BootLogList logs={logs} />
    </div>
  );
}
