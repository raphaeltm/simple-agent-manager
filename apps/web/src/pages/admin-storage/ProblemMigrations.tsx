import type { AdminProjectDataArchiveProblemMigration } from '@simple-agent-manager/shared';
import { Alert, Button, Card, Dialog, Input, Spinner } from '@simple-agent-manager/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle } from 'lucide-react';
import { useState } from 'react';

import { useQueryScope } from '../../hooks/useQueryScope';
import { useToast } from '../../hooks/useToast';
import { abandonAdminProjectDataArchiveMigration } from '../../lib/api';
import {
  adminProjectDataArchiveProblemMigrationsQueryOptions,
  adminProjectDataStorageQueryKeys,
} from '../../lib/query-options';

const MIGRATION_STATE_BADGE: Record<string, { label: string; className: string }> = {
  failed: { label: 'Failed', className: 'bg-danger-tint text-danger-fg' },
  poisoned: { label: 'Poisoned', className: 'bg-danger-tint text-danger-fg' },
  frozen: { label: 'Frozen', className: 'bg-warning-tint text-warning-fg' },
};

const DEFAULT_BADGE = { label: 'Unknown', className: 'bg-surface-secondary text-fg-muted' };

function formatTimestamp(value: number | null): string {
  if (value === null) return '—';
  return new Date(value).toLocaleString();
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

function MigrationCard({
  migration,
  onAbandon,
}: {
  migration: AdminProjectDataArchiveProblemMigration;
  onAbandon: (m: AdminProjectDataArchiveProblemMigration) => void;
}) {
  const badge = MIGRATION_STATE_BADGE[migration.state] ?? DEFAULT_BADGE;
  return (
    <Card data-testid={`migration-${migration.migrationId}`} className="min-w-0">
      <div className="flex flex-col gap-3 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="m-0 min-w-0 break-words text-base font-semibold text-fg-primary">
            {migration.projectId}
          </h3>
          <Badge label={badge.label} className={badge.className} />
        </div>
        <dl className="m-0 min-w-0 grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
          <dt className="text-fg-muted">Migration</dt>
          <dd className="m-0 break-all font-mono text-xs text-fg-primary">
            {migration.migrationId}
          </dd>
          <dt className="text-fg-muted">Session</dt>
          <dd className="m-0 break-all font-mono text-xs text-fg-primary">
            {migration.sessionId}
          </dd>
          {migration.errorCode && (
            <>
              <dt className="text-fg-muted">Error code</dt>
              <dd className="m-0 break-words text-fg-primary">{migration.errorCode}</dd>
            </>
          )}
          {migration.errorMessage && (
            <>
              <dt className="text-fg-muted">Error</dt>
              <dd className="m-0 break-words text-xs text-fg-primary">{migration.errorMessage}</dd>
            </>
          )}
          <dt className="text-fg-muted">Attempts</dt>
          <dd className="m-0 text-fg-primary">{migration.attemptCount}</dd>
          {migration.frozenAt && (
            <>
              <dt className="text-fg-muted">Frozen</dt>
              <dd className="m-0 text-fg-primary">{formatTimestamp(migration.frozenAt)}</dd>
            </>
          )}
          {migration.poisonedAt && (
            <>
              <dt className="text-fg-muted">Poisoned</dt>
              <dd className="m-0 text-fg-primary">{formatTimestamp(migration.poisonedAt)}</dd>
            </>
          )}
          <dt className="text-fg-muted">Updated</dt>
          <dd className="m-0 text-fg-primary">{formatTimestamp(migration.updatedAt)}</dd>
        </dl>
        <Button
          type="button"
          variant="danger"
          onClick={() => onAbandon(migration)}
          className="w-full sm:w-auto sm:self-start"
        >
          <AlertTriangle size={16} />
          Abandon
        </Button>
      </div>
    </Card>
  );
}

export function ProblemMigrations() {
  const queryScope = useQueryScope();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [target, setTarget] = useState<AdminProjectDataArchiveProblemMigration | null>(null);
  const [reason, setReason] = useState('');

  const migrationsQuery = useQuery({
    ...adminProjectDataArchiveProblemMigrationsQueryOptions(queryScope),
    enabled: Boolean(queryScope),
  });

  const abandonMigration = useMutation({
    mutationFn: (input: { projectId: string; migrationId: string; reason: string }) =>
      abandonAdminProjectDataArchiveMigration(input.projectId, input.migrationId, input.reason),
    onSuccess: async () => {
      toast.success(
        `Migration ${target?.migrationId} abandoned for ${target?.projectId}`
      );
      setTarget(null);
      setReason('');
      await queryClient.invalidateQueries({
        queryKey: adminProjectDataStorageQueryKeys.all(queryScope),
      });
    },
    onError: (error) => {
      toast.error(errorMessage(error, 'Failed to abandon the migration'));
    },
  });

  const migrations = migrationsQuery.data?.migrations ?? [];
  const trimmedReason = reason.trim();

  const openDialog = (migration: AdminProjectDataArchiveProblemMigration) => {
    abandonMigration.reset();
    setReason('');
    setTarget(migration);
  };
  const dismissDialog = () => {
    if (abandonMigration.isPending) return;
    setTarget(null);
  };

  return (
    <>
      <section className="grid gap-3">
        <h2 className="m-0 text-base font-semibold text-fg-primary">Problem migrations</h2>
        <p className="m-0 text-xs text-fg-muted">
          Closing a breaker resumes the scheduled sweep but does not thaw already frozen migrations.
          Abandon is for migrations that never reached source deletion.
        </p>
        {migrationsQuery.isError && !migrationsQuery.data && (
          <Alert variant="error">
            {errorMessage(migrationsQuery.error, 'Failed to load problem migrations')}
          </Alert>
        )}
        {migrationsQuery.isPending && !migrationsQuery.isError && (
          <div className="flex justify-center py-6">
            <Spinner />
          </div>
        )}
        {migrationsQuery.data && migrations.length === 0 && (
          <p className="m-0 text-sm text-fg-muted">No problem migrations.</p>
        )}
        {migrations.map((migration) => (
          <MigrationCard
            key={migration.migrationId}
            migration={migration}
            onAbandon={openDialog}
          />
        ))}
        {migrationsQuery.data && migrations.length >= migrationsQuery.data.limit && (
          <p className="m-0 text-xs text-fg-muted">
            Showing the first {migrations.length} problem migrations (limit:{' '}
            {migrationsQuery.data.limit}). More may exist beyond this limit.
          </p>
        )}
        {migrationsQuery.data &&
          migrationsQuery.data.warnings
            .filter((w) => w.skippedRows > 0)
            .map((w) => (
              <p key={w.surface} className="m-0 text-xs text-fg-muted">
                {w.skippedRows} malformed row(s) were skipped.
              </p>
            ))}
      </section>

      <Dialog
        isOpen={target !== null}
        onClose={dismissDialog}
        aria-labelledby="abandon-migration-title"
      >
        {target && (
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (!trimmedReason || abandonMigration.isPending) return;
              abandonMigration.mutate({
                projectId: target.projectId,
                migrationId: target.migrationId,
                reason: trimmedReason,
              });
            }}
          >
            <h2 id="abandon-migration-title" className="m-0 text-lg font-semibold text-fg-primary">
              Abandon migration
            </h2>
            <p className="m-0 break-words text-sm text-fg-muted">
              This drops the partial shard copy, returns the session to root, and freezes the journal
              as <span className="font-semibold text-fg-primary">operator_abandoned</span>. The
              session will be eligible for the sweep again.
            </p>
            <dl className="m-0 grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
              <dt className="text-fg-muted">Project</dt>
              <dd className="m-0 break-words font-semibold text-fg-primary">
                {target.projectId}
              </dd>
              <dt className="text-fg-muted">Migration</dt>
              <dd className="m-0 break-all font-mono text-xs text-fg-primary">
                {target.migrationId}
              </dd>
              <dt className="text-fg-muted">Session</dt>
              <dd className="m-0 break-all font-mono text-xs text-fg-primary">
                {target.sessionId}
              </dd>
            </dl>
            <label className="grid gap-1 text-sm text-fg-primary">
              Reason
              <Input
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder="Why is this migration being abandoned?"
                maxLength={500}
                required
              />
            </label>
            {abandonMigration.isError && (
              <Alert variant="error">
                {errorMessage(abandonMigration.error, 'Failed to abandon the migration')}
              </Alert>
            )}
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button type="button" variant="secondary" onClick={dismissDialog}>
                Cancel
              </Button>
              <Button
                type="submit"
                variant="danger"
                loading={abandonMigration.isPending}
                disabled={!trimmedReason}
              >
                Abandon migration
              </Button>
            </div>
          </form>
        )}
      </Dialog>
    </>
  );
}
