import type { ProjectRuntimeConfigResponse } from '@simple-agent-manager/shared';
import { Link } from 'react-router';

type RuntimeEnvVar = ProjectRuntimeConfigResponse['envVars'][number];

function formatTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export interface RuntimeEnvVarItemProps {
  projectId: string;
  item: RuntimeEnvVar;
  isLast: boolean;
  saving: boolean;
  onDelete: () => void;
}

/**
 * One project runtime env var. Values an agent asked for (`request_secret`) carry a "collected"
 * badge with who supplied them, why, from which chat, and when they expire. Expired values are
 * already refused by exec and are deleted by the daily purge.
 */
export function RuntimeEnvVarItem({
  projectId,
  item,
  isLast,
  saving,
  onDelete,
}: RuntimeEnvVarItemProps) {
  const collected = item.collected ?? null;
  return (
    <div
      className={`grid gap-1 px-2 py-1.5 text-[0.8125rem] ${isLast ? '' : 'border-b border-border-default'}`}
      data-testid="runtime-env-var"
    >
      <div className="flex min-w-0 items-center gap-2">
        {/* The name is the row's primary content: wrap it rather than truncate (rule 56). */}
        <code className="min-w-0 flex-1 text-[0.8125rem] font-semibold text-fg-primary [overflow-wrap:anywhere]">
          {item.key}
        </code>
        <span className="min-w-0 max-w-[40%] shrink overflow-hidden text-ellipsis whitespace-nowrap text-fg-muted">
          {item.isSecret ? '••••••' : `= ${item.value}`}
        </span>
        {collected && (
          <span className="shrink-0 rounded-sm bg-info-tint px-1.5 py-px text-[0.6875rem] text-info-fg">
            collected
          </span>
        )}
        {item.expired && (
          <span className="shrink-0 rounded-sm bg-danger-tint px-1.5 py-px text-[0.6875rem] text-danger-fg">
            expired
          </span>
        )}
        {item.isSecret && (
          <span className="shrink-0 rounded-sm bg-inset px-1.5 py-px text-[0.6875rem] text-fg-muted">
            secret
          </span>
        )}
        <button
          onClick={onDelete}
          disabled={saving}
          className="inline-flex shrink-0 cursor-pointer items-center justify-center rounded-sm border-none bg-transparent p-1 text-fg-muted transition-colors hover:text-danger"
          aria-label={`Remove ${item.key}`}
          title={`Remove ${item.key}`}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>
      {(collected || item.expiresAt) && (
        <div className="text-xs text-fg-muted [overflow-wrap:anywhere]">
          {collected && (
            <>
              Asked for by an agent
              {collected.suppliedByName ? `, supplied by ${collected.suppliedByName}` : ''}
              {collected.suppliedAt ? ` on ${formatTime(collected.suppliedAt)}` : ''}
              {collected.requestingChatSessionId && (
                <>
                  {' '}
                  (
                  <Link
                    to={`/projects/${projectId}/chat/${collected.requestingChatSessionId}`}
                    className="text-accent hover:underline"
                  >
                    open chat
                  </Link>
                  )
                </>
              )}
              . {collected.reason && <span className="italic">“{collected.reason}”</span>}{' '}
            </>
          )}
          {item.expiresAt &&
            (item.expired
              ? `Expired ${formatTime(item.expiresAt)}; agents can no longer use it.`
              : `Expires ${formatTime(item.expiresAt)}.`)}
        </div>
      )}
    </div>
  );
}
