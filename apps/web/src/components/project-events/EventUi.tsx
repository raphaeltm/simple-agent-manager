import type { ProjectEventFilterV1, ProjectScheduledAction } from '@simple-agent-manager/shared';
import { Button, Spinner } from '@simple-agent-manager/ui';
import type { ReactNode } from 'react';
import { useId, useState } from 'react';
import { Link } from 'react-router';

export const controlClass =
  'w-full min-w-0 min-h-11 rounded-md border border-border-default bg-inset px-3 py-2 text-sm text-fg-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus-ring';
export const cardClass =
  'glass-surface min-w-0 rounded-lg border border-border-default p-4 space-y-3';
export const linkClass =
  'text-accent underline underline-offset-2 break-words focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus-ring';
export const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
export function dateLabel(value: number | null, zone = timezone) {
  if (value === null) return 'None';
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: zone,
  }).format(value);
}
export function localDateInput(value: number) {
  const date = new Date(value);
  return new Date(value - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}
export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: (id: string) => ReactNode;
  hint?: string;
}) {
  const id = useId();
  return (
    <div className="min-w-0 space-y-1">
      <label htmlFor={id} className="block text-sm font-medium text-fg-primary">
        {label}
      </label>
      {children(id)}
      {hint && <p className="m-0 text-xs text-fg-muted">{hint}</p>}
    </div>
  );
}
export function Feedback({ error, message }: { error?: unknown; message?: string | null }) {
  return (
    <>
      {Boolean(error) && (
        <p
          role="alert"
          className="m-0 rounded-md border border-border-default p-3 text-sm text-danger break-words"
        >
          {error instanceof Error ? error.message : String(error)}{' '}
          <span className="text-fg-muted">
            If this changed elsewhere, refresh before trying again.
          </span>
        </p>
      )}
      {message && (
        <p role="status" className="m-0 text-sm text-fg-primary break-words">
          {message}
        </p>
      )}
    </>
  );
}
export function QueryState({
  pending,
  error,
  empty,
  onRetry,
  children,
}: {
  pending: boolean;
  error: unknown;
  empty: boolean;
  onRetry: () => void;
  children: ReactNode;
}) {
  if (pending)
    return (
      <div role="status" className="flex items-center gap-2 p-4 text-fg-muted">
        <Spinner size="sm" /> Loading…
      </div>
    );
  if (error)
    return (
      <div className="space-y-3">
        <Feedback error={error} />
        <Button variant="secondary" onClick={onRetry}>
          Try again
        </Button>
      </div>
    );
  if (empty)
    return (
      <p className="rounded-lg border border-dashed border-border-default p-6 text-sm text-fg-muted">
        Nothing here yet. New records will appear after they are created.
      </p>
    );
  return <>{children}</>;
}
export function StateBadge({ state }: { state: string }) {
  return (
    <span className="inline-flex rounded-md border border-border-default bg-inset px-2 py-1 text-xs font-medium text-fg-primary">
      {state.replaceAll('_', ' ')}
    </span>
  );
}
export function ActionSummary({
  action,
  projectId,
}: {
  action: ProjectScheduledAction;
  projectId: string;
}) {
  return (
    <div className="space-y-1 min-w-0">
      <p className="m-0 text-sm">
        {action.kind === 'message_session' ? (
          <>
            Message{' '}
            <Link className={linkClass} to={`/projects/${projectId}/chat/${action.sessionId}`}>
              session {action.sessionId.slice(0, 8)}
            </Link>
          </>
        ) : (
          'Start a new session'
        )}
      </p>
      <p className="m-0 whitespace-pre-wrap break-words text-sm text-fg-muted">{action.prompt}</p>
    </div>
  );
}
export function FilterSummary({ filter }: { filter: ProjectEventFilterV1 }) {
  return (
    <dl className="m-0 grid gap-1 text-xs text-fg-muted">
      {Object.entries(filter)
        .filter(([key]) => key !== 'version')
        .map(([key, value]) => (
          <div key={key} className="flex flex-wrap gap-x-2">
            <dt className="font-medium">{key}</dt>
            <dd className="m-0 break-all">{Array.isArray(value) ? value.join(', ') : value}</dd>
          </div>
        ))}
    </dl>
  );
}
/** No effects: refresh cannot reset an edit or overwrite a mutation's feedback. */
export function useEventAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [message, setMessage] = useState<string | null>(null);
  async function run(action: () => Promise<string | void>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      setMessage((await action()) ?? null);
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, message, run };
}
