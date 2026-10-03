import type {
  AdminProjectDataStorageTelemetryRow,
  GroupedFtsWallRecoveryLimits,
  GroupedFtsWallRecoveryRequest,
  GroupedFtsWallRecoveryResult,
  GroupedFtsWallRecoveryStopReason,
} from '@simple-agent-manager/shared';
import { Alert, Button, Dialog, Input, Spinner } from '@simple-agent-manager/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Eraser, ScanSearch } from 'lucide-react';
import { useState } from 'react';

import { formatBytes } from '../../components/deployments/deployment-card-format';
import { useQueryScope } from '../../hooks/useQueryScope';
import { useToast } from '../../hooks/useToast';
import { runAdminProjectDataWallRecovery } from '../../lib/api';
import {
  adminProjectDataStorageQueryKeys,
  adminProjectDataWallRecoveryConfigQueryOptions,
} from '../../lib/query-options';

const MIB = 1024 * 1024;

const STOP_REASON_LABEL: Record<GroupedFtsWallRecoveryStopReason, string> = {
  candidates_exhausted: 'No more eligible sessions',
  row_budget: 'Row limit reached',
  byte_budget: 'Size limit reached',
  session_budget: 'Session limit reached',
  transaction_failed: 'Stopped by a failed page',
};

type BudgetField = 'maxSessions' | 'maxRows' | 'maxBytes';
type BudgetInputs = Record<BudgetField, string | null>;

const BUDGET_FIELDS: Array<{ field: BudgetField; label: string; unit: 'count' | 'mib' }> = [
  { field: 'maxSessions', label: 'Sessions', unit: 'count' },
  { field: 'maxRows', label: 'Rows', unit: 'count' },
  { field: 'maxBytes', label: 'Size (MiB)', unit: 'mib' },
];

/** MiB with at most two decimals, rounded down so a prefilled value never exceeds its bound. */
function toMib(bytes: number): string {
  return String(Math.floor((bytes / MIB) * 100) / 100);
}

function display(field: BudgetField, value: number): string {
  return field === 'maxBytes' ? toMib(value) : value.toLocaleString();
}

/** The API's bound for one budget, as a request value, or an error message. */
export function parseBudget(
  field: BudgetField,
  raw: string,
  ceiling: number
): { value: number } | { error: string } {
  const text = raw.trim();
  if (field === 'maxBytes') {
    const mib = Number(text);
    const bytes = Math.floor(mib * MIB);
    if (!text || !Number.isFinite(mib) || bytes < 1) return { error: 'Enter a size above 0 MiB' };
    if (bytes > ceiling) return { error: `At most ${toMib(ceiling)} MiB` };
    return { value: bytes };
  }
  if (!/^\d+$/.test(text) || Number(text) < 1)
    return { error: 'Enter a whole number of 1 or more' };
  const value = Number(text);
  if (value > ceiling) return { error: `At most ${ceiling.toLocaleString()}` };
  return { value };
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function RecoveryResult({ result }: { result: GroupedFtsWallRecoveryResult }) {
  const delta = result.databaseSizeDeltaBytes;
  return (
    <section
      aria-label={result.dryRun ? 'Preview result' : 'Recovery result'}
      className="grid min-w-0 gap-2 rounded-md border border-border-default bg-inset p-3 text-sm"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-semibold text-fg-primary">
          {result.dryRun ? 'Preview: nothing was changed' : 'Recovery finished'}
        </span>
        <span className="text-xs text-fg-muted">{STOP_REASON_LABEL[result.stopReason]}</span>
      </div>
      <dl className="m-0 grid gap-x-4 gap-y-1 sm:grid-cols-[auto_1fr]">
        <dt className="text-fg-muted">{result.dryRun ? 'Would prune' : 'Pruned'}</dt>
        <dd className="m-0 break-words text-fg-primary">
          {result.groupedRowsDeleted.toLocaleString()} rows ({formatBytes(result.contentBytes)} of
          indexed text) from {result.sessionsTouched.toLocaleString()} of{' '}
          {result.candidateSessions.toLocaleString()} sessions
        </dd>
        {!result.dryRun && (
          <>
            <dt className="text-fg-muted">Storage</dt>
            <dd className="m-0 break-words text-fg-primary">
              {formatBytes(result.beforeBytes)} → {formatBytes(result.afterBytes)} (
              {delta >= 0 ? `freed ${formatBytes(delta)}` : `grew ${formatBytes(-delta)}`})
            </dd>
            <dt className="text-fg-muted">Search entries</dt>
            <dd className="m-0 text-fg-primary">
              {result.ftsEntriesDeleted.toLocaleString()} removed
            </dd>
          </>
        )}
      </dl>
      {result.dryRun && (
        <p className="m-0 text-xs text-fg-muted">
          The space actually freed depends on the search index; a real run reports the measured
          change.
        </p>
      )}
      {result.ftsStaleRows > 0 && (
        <Alert variant="warning">
          {result.ftsStaleRows.toLocaleString()} search entries did not fit and were left stale.
          Search ignores them, but they keep using space until the index is rebuilt.
        </Alert>
      )}
    </section>
  );
}

/**
 * Admin → Storage control for the superadmin grouped-FTS wall recovery: prunes the search index
 * of the largest old ended sessions to free space when a project's storage is at Cloudflare's
 * hard cap. Budgets come from the API (`/grouped-fts-wall-recovery/config`), never from here.
 * Render it with `key={target?.project_id}` so each project opens with a fresh form.
 */
export function WallRecoveryDialog({
  target,
  onClose,
}: {
  target: AdminProjectDataStorageTelemetryRow | null;
  onClose: () => void;
}) {
  const queryScope = useQueryScope();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [reason, setReason] = useState('');
  // null = still showing the API's default for that field.
  const [inputs, setInputs] = useState<BudgetInputs>({
    maxSessions: null,
    maxRows: null,
    maxBytes: null,
  });
  const [skipSessionIds, setSkipSessionIds] = useState<string[]>([]);

  const configQuery = useQuery({
    ...adminProjectDataWallRecoveryConfigQueryOptions(queryScope),
    enabled: Boolean(queryScope) && target !== null,
  });
  const recovery = useMutation({
    mutationFn: (body: GroupedFtsWallRecoveryRequest) =>
      runAdminProjectDataWallRecovery(target?.project_id ?? '', body),
    onSuccess: async ({ result }) => {
      if (result.dryRun) return;
      if (result.stopReason !== 'transaction_failed') {
        toast.success(
          `Recovered ${formatBytes(Math.max(result.databaseSizeDeltaBytes, 0))} for ${
            target?.project_name ?? result.projectId
          }`
        );
      }
      await queryClient.invalidateQueries({
        queryKey: adminProjectDataStorageQueryKeys.all(queryScope),
      });
    },
    onError: (error) => {
      toast.error(errorMessage(error, 'Space recovery failed'));
    },
  });

  const config = configQuery.data;
  const parsed = config
    ? BUDGET_FIELDS.map(({ field }) => ({
        field,
        result: parseBudget(
          field,
          inputs[field] ??
            (field === 'maxBytes' ? toMib(config.defaults[field]) : String(config.defaults[field])),
          config.ceilings[field]
        ),
      }))
    : [];
  const budgets = parsed.every((entry) => 'value' in entry.result)
    ? (Object.fromEntries(
        parsed.map((entry) => [entry.field, (entry.result as { value: number }).value])
      ) as unknown as GroupedFtsWallRecoveryLimits)
    : null;
  const trimmedReason = reason.trim();
  const canRun = Boolean(config && budgets && trimmedReason) && !recovery.isPending;
  const result = recovery.data?.result ?? null;
  const failedSessionId = result?.failedSessionId ?? null;
  const skipFull = config ? skipSessionIds.length >= config.ceilings.maxSessions : true;

  const run = (dryRun: boolean) => {
    if (!canRun || !budgets) return;
    recovery.mutate({ reason: trimmedReason, dryRun, ...budgets, skipSessionIds });
  };
  const dismiss = () => {
    if (recovery.isPending) return;
    onClose();
  };
  const skipFailedSession = () => {
    if (!failedSessionId || skipFull) return;
    setSkipSessionIds((current) =>
      current.includes(failedSessionId) ? current : [...current, failedSessionId]
    );
  };

  return (
    <Dialog isOpen={target !== null} onClose={dismiss} aria-labelledby="wall-recovery-title">
      {target && (
        <form
          className="grid min-w-0 gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            run(true);
          }}
        >
          <h2 id="wall-recovery-title" className="m-0 text-lg font-semibold text-fg-primary">
            Recover storage space
          </h2>
          <p className="m-0 break-words text-sm text-fg-muted">
            Removes the search index of the largest old, ended sessions in{' '}
            <span className="font-semibold text-fg-primary">
              {target.project_name ?? target.project_id}
            </span>{' '}
            ({formatBytes(target.database_size_bytes)} used). Message text is not touched; those
            sessions fall back to a narrower plain-text search. Preview first.
          </p>
          <label className="grid gap-1 text-sm text-fg-primary">
            Reason
            <Input
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Why is space being recovered?"
              maxLength={500}
              required
            />
          </label>
          {configQuery.isError && !config && (
            <Alert variant="error">
              {errorMessage(configQuery.error, 'Failed to load the recovery limits')}
            </Alert>
          )}
          {!config && !configQuery.isError && (
            <div className="flex justify-center py-2">
              <Spinner />
            </div>
          )}
          {config && (
            <fieldset className="m-0 grid min-w-0 gap-3 border-0 p-0 sm:grid-cols-3">
              <legend className="mb-2 p-0 text-sm text-fg-muted">Limits for this run</legend>
              {BUDGET_FIELDS.map(({ field, label, unit }) => {
                const entry = parsed.find((item) => item.field === field);
                const error = entry && 'error' in entry.result ? entry.result.error : null;
                const id = `wall-recovery-${field}`;
                return (
                  <div key={field} className="grid min-w-0 gap-1 text-sm text-fg-primary">
                    <label htmlFor={id}>{label}</label>
                    <Input
                      id={id}
                      inputMode={unit === 'mib' ? 'decimal' : 'numeric'}
                      value={
                        inputs[field] ??
                        (unit === 'mib'
                          ? toMib(config.defaults[field])
                          : String(config.defaults[field]))
                      }
                      onChange={(event) =>
                        setInputs((current) => ({ ...current, [field]: event.target.value }))
                      }
                      aria-invalid={error !== null}
                      aria-describedby={`${id}-hint`}
                    />
                    <span
                      id={`${id}-hint`}
                      className={`text-xs ${error ? 'text-danger-fg' : 'text-fg-muted'}`}
                    >
                      {error ?? `Max ${display(field, config.ceilings[field])}`}
                    </span>
                  </div>
                );
              })}
            </fieldset>
          )}
          {skipSessionIds.length > 0 && (
            <div className="grid gap-1 text-xs text-fg-muted">
              <span>Skipping {skipSessionIds.length.toLocaleString()} session(s):</span>
              <span className="break-all font-mono text-fg-primary">
                {skipSessionIds.join(', ')}
              </span>
              <button
                type="button"
                className="justify-self-start text-accent underline"
                onClick={() => setSkipSessionIds([])}
                disabled={recovery.isPending}
              >
                Clear skipped sessions
              </button>
            </div>
          )}
          {recovery.isError && (
            <Alert variant="error">{errorMessage(recovery.error, 'Space recovery failed')}</Alert>
          )}
          {result?.stopReason === 'transaction_failed' && (
            <Alert variant="warning">
              <span className="break-words">
                A page failed{result.error ? `: ${result.error}` : ''}. Pages before it may already
                have been applied (shown below). Nothing retries automatically.
              </span>
              {failedSessionId && !skipSessionIds.includes(failedSessionId) && (
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  className="mt-2"
                  onClick={skipFailedSession}
                  disabled={skipFull || recovery.isPending}
                >
                  Skip this session next run
                </Button>
              )}
            </Alert>
          )}
          {result && <RecoveryResult result={result} />}
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button type="button" variant="ghost" onClick={dismiss} disabled={recovery.isPending}>
              Close
            </Button>
            <Button
              type="submit"
              variant="secondary"
              disabled={!canRun}
              loading={recovery.isPending && recovery.variables?.dryRun === true}
            >
              <ScanSearch size={16} />
              Preview
            </Button>
            <Button
              type="button"
              variant="danger"
              onClick={() => run(false)}
              disabled={!canRun}
              loading={recovery.isPending && recovery.variables?.dryRun === false}
            >
              <Eraser size={16} />
              Recover space
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
