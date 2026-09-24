import type {
  AdminProjectDataArchiveCircuitBreaker,
  AdminProjectDataStorageTelemetryRow,
} from '@simple-agent-manager/shared';
import { Alert, Button, Card, Dialog, Input, Spinner } from '@simple-agent-manager/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ShieldCheck } from 'lucide-react';
import { useState } from 'react';

import { formatBytes } from '../components/deployments/deployment-card-format';
import { useQueryScope } from '../hooks/useQueryScope';
import { useToast } from '../hooks/useToast';
import { closeAdminProjectDataArchiveCircuitBreaker } from '../lib/api';
import {
  adminProjectDataArchiveBreakersQueryOptions,
  adminProjectDataStorageQueryKeys,
  adminProjectDataStorageTelemetryQueryOptions,
} from '../lib/query-options';
import { ProblemMigrations } from './admin-storage/ProblemMigrations';

const DEFAULT_CLOSE_REASON = 'Closed from admin UI';

const BREAKER_BADGE: Record<
  AdminProjectDataArchiveCircuitBreaker['state'],
  { label: string; className: string }
> = {
  open: { label: 'Open', className: 'bg-danger-tint text-danger-fg' },
  frozen: { label: 'Frozen', className: 'bg-warning-tint text-warning-fg' },
  closed: { label: 'Closed', className: 'bg-success-tint text-success-fg' },
};

const STORAGE_STATUS_CLASS: Record<string, string> = {
  ok: 'bg-success-tint text-success-fg',
  notice: 'bg-info-tint text-info-fg',
  warning: 'bg-warning-tint text-warning-fg',
  critical: 'bg-danger-tint text-danger-fg',
  degraded: 'bg-danger-tint text-danger-fg',
};

function formatTimestamp(value: number | null): string {
  if (value === null) return '—';
  return new Date(value).toLocaleString();
}

function formatPercent(ratio: number): string {
  return `${(ratio * 100).toLocaleString(undefined, { maximumFractionDigits: 1 })}%`;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function Badge({ label, className }: { label: string; className: string }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${className}`}
    >
      {label}
    </span>
  );
}

function BreakerCard({
  breaker,
  telemetry,
  onClose,
}: {
  breaker: AdminProjectDataArchiveCircuitBreaker;
  telemetry: AdminProjectDataStorageTelemetryRow | undefined;
  onClose: (breaker: AdminProjectDataArchiveCircuitBreaker) => void;
}) {
  const badge = BREAKER_BADGE[breaker.state];
  return (
    <Card data-testid={`breaker-${breaker.projectId}`} className="min-w-0">
      <div className="flex flex-col gap-3 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="m-0 min-w-0 break-words text-base font-semibold text-fg-primary">
            {breaker.projectName ?? breaker.projectId}
          </h3>
          <Badge label={badge.label} className={badge.className} />
        </div>
        <dl className="m-0 grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
          <dt className="text-fg-muted">Project</dt>
          <dd className="m-0 break-all font-mono text-xs text-fg-primary">
            {breaker.repository ?? breaker.projectId}
          </dd>
          <dt className="text-fg-muted">Reason</dt>
          <dd className="m-0 break-words text-fg-primary">{breaker.reason ?? '—'}</dd>
          <dt className="text-fg-muted">Opened</dt>
          <dd className="m-0 text-fg-primary">{formatTimestamp(breaker.openedAt)}</dd>
          <dt className="text-fg-muted">Updated</dt>
          <dd className="m-0 text-fg-primary">{formatTimestamp(breaker.updatedAt)}</dd>
          {telemetry && (
            <>
              <dt className="text-fg-muted">Storage</dt>
              <dd className="m-0 text-fg-primary">
                {formatBytes(telemetry.database_size_bytes)} of {formatBytes(telemetry.limit_bytes)}{' '}
                ({formatPercent(telemetry.usage_ratio)})
              </dd>
            </>
          )}
        </dl>
        {breaker.state !== 'closed' && (
          <Button
            type="button"
            variant="primary"
            onClick={() => onClose(breaker)}
            className="w-full sm:w-auto sm:self-start"
          >
            <ShieldCheck size={16} />
            Close breaker
          </Button>
        )}
      </div>
    </Card>
  );
}

function TelemetryRow({ row }: { row: AdminProjectDataStorageTelemetryRow }) {
  const statusClass = STORAGE_STATUS_CLASS[row.status] ?? 'bg-surface-secondary text-fg-muted';
  return (
    <li className="flex flex-col gap-1 border-b border-border-default py-3 last:border-b-0">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 break-words text-sm font-semibold text-fg-primary">
          {row.project_name ?? row.project_id}
        </span>
        <Badge label={row.status} className={statusClass} />
      </div>
      <div className="text-sm text-fg-muted">
        {formatBytes(row.database_size_bytes)} of {formatBytes(row.limit_bytes)} (
        {formatPercent(row.usage_ratio)})
        {row.growth_rate_bytes_per_day !== null && (
          <> · {formatBytes(row.growth_rate_bytes_per_day)}/day</>
        )}
        {row.estimated_days_to_limit !== null && (
          <> · ~{Math.round(row.estimated_days_to_limit).toLocaleString()} days to limit</>
        )}
        {row.cleanup_health && <> · cleanup {row.cleanup_health}</>}
      </div>
      {row.last_error && (
        <div className="break-words text-xs text-danger-fg">Last error: {row.last_error}</div>
      )}
    </li>
  );
}

export function AdminStorage() {
  const queryScope = useQueryScope();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [target, setTarget] = useState<AdminProjectDataArchiveCircuitBreaker | null>(null);
  const [reason, setReason] = useState(DEFAULT_CLOSE_REASON);

  const breakersQuery = useQuery({
    ...adminProjectDataArchiveBreakersQueryOptions(queryScope),
    enabled: Boolean(queryScope),
  });
  const telemetryQuery = useQuery({
    ...adminProjectDataStorageTelemetryQueryOptions(queryScope),
    enabled: Boolean(queryScope),
  });

  const closeBreaker = useMutation({
    mutationFn: (input: { projectId: string; reason: string }) =>
      closeAdminProjectDataArchiveCircuitBreaker(input.projectId, input.reason),
    onSuccess: async (response) => {
      toast.success(
        `Archive breaker closed for ${target?.projectName ?? response.result.projectId}`
      );
      setTarget(null);
      setReason(DEFAULT_CLOSE_REASON);
      await queryClient.invalidateQueries({
        queryKey: adminProjectDataStorageQueryKeys.all(queryScope),
      });
    },
    onError: (error) => {
      toast.error(errorMessage(error, 'Failed to close the archive breaker'));
    },
  });

  const breakers = breakersQuery.data?.breakers ?? [];
  const telemetry = telemetryQuery.data?.telemetry ?? [];
  const telemetryByProject = new Map(telemetry.map((row) => [row.project_id, row]));
  const trimmedReason = reason.trim();

  const openDialog = (breaker: AdminProjectDataArchiveCircuitBreaker) => {
    closeBreaker.reset();
    setReason(DEFAULT_CLOSE_REASON);
    setTarget(breaker);
  };
  const dismissDialog = () => {
    if (closeBreaker.isPending) return;
    setTarget(null);
  };

  return (
    <div className="grid min-w-0 gap-4">
      <section className="glass-surface rounded-lg p-4">
        <h2 className="sam-type-section-heading m-0 text-fg-primary">Storage</h2>
        <p className="m-0 mt-1 text-sm text-fg-muted">
          ProjectData storage health and the per-project archive circuit breakers. A tripped breaker
          stops the scheduled archive drain for that project until an admin closes it here.
        </p>
      </section>

      <section className="grid gap-3">
        <h2 className="m-0 text-base font-semibold text-fg-primary">Archive circuit breakers</h2>
        {breakersQuery.isError && !breakersQuery.data && (
          <Alert variant="error">
            {errorMessage(breakersQuery.error, 'Failed to load archive circuit breakers')}
          </Alert>
        )}
        {breakersQuery.isPending && !breakersQuery.isError && (
          <div className="flex justify-center py-6">
            <Spinner />
          </div>
        )}
        {breakersQuery.data && breakers.length === 0 && (
          <p className="m-0 text-sm text-fg-muted">No archive circuit breakers recorded.</p>
        )}
        {breakers.map((breaker) => (
          <BreakerCard
            key={breaker.projectId}
            breaker={breaker}
            telemetry={telemetryByProject.get(breaker.projectId)}
            onClose={openDialog}
          />
        ))}
        {breakersQuery.data && breakersQuery.data.skippedRows > 0 && (
          <p className="m-0 text-xs text-fg-muted">
            {breakersQuery.data.skippedRows} malformed breaker row(s) were skipped.
          </p>
        )}
      </section>

      <ProblemMigrations />

      <section className="grid gap-3">
        <h2 className="m-0 text-base font-semibold text-fg-primary">Storage telemetry</h2>
        {telemetryQuery.isError && !telemetryQuery.data && (
          <Alert variant="error">
            {errorMessage(telemetryQuery.error, 'Failed to load storage telemetry')}
          </Alert>
        )}
        {telemetryQuery.isPending && !telemetryQuery.isError && (
          <div className="flex justify-center py-6">
            <Spinner />
          </div>
        )}
        {telemetryQuery.data && telemetry.length === 0 && (
          <p className="m-0 text-sm text-fg-muted">No storage telemetry recorded yet.</p>
        )}
        {telemetry.length > 0 && (
          <Card>
            <ul className="m-0 list-none px-4 py-1">
              {telemetry.map((row) => (
                <TelemetryRow key={row.project_id} row={row} />
              ))}
            </ul>
          </Card>
        )}
      </section>

      <Dialog
        isOpen={target !== null}
        onClose={dismissDialog}
        aria-labelledby="close-breaker-title"
      >
        {target && (
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (!trimmedReason || closeBreaker.isPending) return;
              closeBreaker.mutate({ projectId: target.projectId, reason: trimmedReason });
            }}
          >
            <h2 id="close-breaker-title" className="m-0 text-lg font-semibold text-fg-primary">
              Close archive circuit breaker
            </h2>
            <p className="m-0 break-words text-sm text-fg-muted">
              This lets the scheduled archive sweep resume for{' '}
              <span className="font-semibold text-fg-primary">
                {target.projectName ?? target.projectId}
              </span>
              . Already frozen migrations stay frozen until they are copied back or abandoned.
            </p>
            <label className="grid gap-1 text-sm text-fg-primary">
              Reason
              <Input
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                maxLength={500}
                required
              />
            </label>
            {closeBreaker.isError && (
              <Alert variant="error">
                {errorMessage(closeBreaker.error, 'Failed to close the archive breaker')}
              </Alert>
            )}
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button type="button" variant="secondary" onClick={dismissDialog}>
                Cancel
              </Button>
              <Button
                type="submit"
                variant="primary"
                loading={closeBreaker.isPending}
                disabled={!trimmedReason}
              >
                Close breaker
              </Button>
            </div>
          </form>
        )}
      </Dialog>
    </div>
  );
}
