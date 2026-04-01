import type { BootLogEntry } from '@simple-agent-manager/shared';
import { Spinner } from '@simple-agent-manager/ui';
import type { FC } from 'react';

function statusIcon(status: BootLogEntry['status']) {
  switch (status) {
    case 'completed':
      return (
        <span className="text-success-fg mr-2" style={{ fontSize: 'var(--sam-type-secondary-size)' }} aria-label="Step completed" role="img">&#10003;</span>
      );
    case 'failed':
      return (
        <span className="text-danger-fg mr-2" style={{ fontSize: 'var(--sam-type-secondary-size)' }} aria-label="Step failed" role="img">&#10007;</span>
      );
    case 'started':
    default:
      return (
        <span className="mr-2 inline-flex" aria-label="Step in progress" role="img">
          <Spinner size="sm" />
        </span>
      );
  }
}

/** Deduplicate boot log entries — show latest status per step. */
function deduplicateSteps(logs: BootLogEntry[]): BootLogEntry[] {
  const stepMap = new Map<string, BootLogEntry>();
  for (const log of logs) {
    stepMap.set(log.step, log);
  }
  return Array.from(stepMap.values());
}

interface BootLogListProps {
  logs: BootLogEntry[];
  /** Max width constraint class. Defaults to 'max-w-[400px]'. */
  maxWidthClass?: string;
}

/**
 * Renders a list of boot log entries with status icons (spinner/check/x).
 * Extracted from Workspace.tsx for reuse in both the Workspace page and
 * the BootLogPanel in project chat.
 */
export const BootLogList: FC<BootLogListProps> = ({ logs, maxWidthClass = 'max-w-[400px]' }) => {
  const steps = deduplicateSteps(logs);
  const lastStep = steps[steps.length - 1];

  return (
    <>
      <div className={`flex flex-col gap-1.5 ${maxWidthClass} w-full`} aria-live="polite" aria-atomic="false">
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
                    ? 'var(--sam-color-fg-muted)'
                    : undefined,
            }}
          >
            {statusIcon(entry.status)}
            <span>{entry.message}</span>
          </div>
        ))}
      </div>
      {lastStep?.status === 'failed' && lastStep.detail && (
        <p
          className={`mt-3 mb-0 ${maxWidthClass} text-center break-words text-fg-muted`}
          style={{ fontSize: 'var(--sam-type-caption-size)' }}
        >
          {lastStep.detail}
        </p>
      )}
    </>
  );
};
