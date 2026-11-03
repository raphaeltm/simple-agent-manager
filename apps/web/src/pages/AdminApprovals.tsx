import type {
  OperationsAction,
  OperationsActionApproval,
  OperationsApprovalDecision,
} from '@simple-agent-manager/shared';
import { Body, Button, Card, Spinner } from '@simple-agent-manager/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router';

import { useQueryScope } from '../hooks/useQueryScope';
import { decideOperationsApproval, fetchOperationsApprovals } from '../lib/api';

const ACTION_LABELS: Record<OperationsAction, string> = {
  retry_snapshot: 'Retry snapshot',
  rerun_node_cleanup: 'Re-run node cleanup',
  sleep_session: 'Sleep session',
  delete_workspace: 'Delete workspace',
  delete_node: 'Delete node',
  restart_vm_agent: 'Restart VM agent',
  cancel_stuck_task: 'Cancel stuck task',
};

const STATUS_STYLES: Record<OperationsActionApproval['status'], { bg: string; text: string }> = {
  pending: { bg: 'var(--sam-color-warning-tint)', text: 'var(--sam-color-warning-fg)' },
  approved: { bg: 'var(--sam-color-success-tint)', text: 'var(--sam-color-success)' },
  executed: { bg: 'var(--sam-color-info-tint)', text: 'var(--sam-color-info-fg)' },
  denied: { bg: 'var(--sam-color-danger-tint)', text: 'var(--sam-color-danger-fg)' },
  expired: { bg: 'var(--sam-color-info-tint)', text: 'var(--sam-color-fg-muted)' },
};

function formatTime(value: string | null) {
  if (!value) return '—';
  return new Date(value).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function StatusChip({ status }: { status: OperationsActionApproval['status'] }) {
  const style = STATUS_STYLES[status];
  return (
    <span
      className="inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[0.65rem] font-semibold uppercase"
      style={{ backgroundColor: style.bg, color: style.text }}
    >
      {status}
    </span>
  );
}

function TargetFacts({ approval }: { approval: OperationsActionApproval }) {
  const facts = Object.entries(approval.targetSummary ?? {}).filter(
    ([key, value]) => value !== null && key !== `${approval.targetType}Id`
  );
  if (facts.length === 0) return null;
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
      {facts.map(([key, value]) => (
        <div key={key} className="contents">
          <dt className="text-fg-muted">{key}</dt>
          <dd className="min-w-0 break-all font-mono text-fg-primary">{String(value)}</dd>
        </div>
      ))}
    </dl>
  );
}

function executionMessage(approval: OperationsActionApproval): string | null {
  const message = approval.executionResult?.message;
  return typeof message === 'string' ? message : null;
}

function ApprovalItem({
  approval,
  highlighted,
  deciding,
  onDecide,
}: {
  approval: OperationsActionApproval;
  highlighted: boolean;
  deciding: OperationsApprovalDecision | null;
  onDecide: (decision: OperationsApprovalDecision) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (highlighted) ref.current?.scrollIntoView({ block: 'center' });
  }, [highlighted]);
  const pending = approval.status === 'pending';
  const result = executionMessage(approval);

  return (
    <div
      ref={ref}
      data-testid={`approval-${approval.id}`}
      className={`flex flex-col gap-3 px-4 py-4 ${highlighted ? 'ring-2 ring-inset ring-accent' : ''}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-fg-primary">
            {ACTION_LABELS[approval.action] ?? approval.action}
          </div>
          <div className="break-all font-mono text-xs text-fg-muted">
            {approval.targetType} {approval.targetId}
          </div>
        </div>
        <StatusChip status={approval.status} />
      </div>

      <Body className="whitespace-pre-wrap break-words text-sm">{approval.reason}</Body>
      {approval.evidenceSummary && (
        <details className="text-xs text-fg-muted">
          <summary className="cursor-pointer">Evidence</summary>
          <p className="mt-1 whitespace-pre-wrap break-words">{approval.evidenceSummary}</p>
        </details>
      )}
      <TargetFacts approval={approval} />

      <div className="text-xs text-fg-muted">
        Requested {formatTime(approval.createdAt)} by task{' '}
        <span className="break-all font-mono">{approval.requestingTaskId}</span>
        {pending ? ` · expires ${formatTime(approval.expiresAt)}` : null}
        {approval.autoApproved ? ' · auto-approved' : null}
        {!pending && approval.decidedAt && !approval.autoApproved
          ? ` · decided ${formatTime(approval.decidedAt)}`
          : null}
        {approval.executedAt ? ` · executed ${formatTime(approval.executedAt)}` : null}
      </div>
      {result && <div className="break-words text-xs text-fg-primary">Result: {result}</div>}

      {pending && (
        <div className="grid grid-cols-2 gap-3">
          <Button
            variant="primary"
            className="min-h-11"
            disabled={deciding !== null}
            onClick={() => onDecide('approve')}
          >
            {deciding === 'approve' ? 'Approving…' : 'Approve'}
          </Button>
          <Button
            variant="danger"
            className="min-h-11"
            disabled={deciding !== null}
            onClick={() => onDecide('deny')}
          >
            {deciding === 'deny' ? 'Denying…' : 'Deny'}
          </Button>
        </div>
      )}
    </div>
  );
}

/**
 * Admin → Approvals: a superadmin approves or denies what an Operations-project agent asked to
 * do. The decision is the server-side record `ops_execute_action` checks, and it is delivered to
 * the agent's session as a new prompt.
 */
export function AdminApprovals() {
  const scope = useQueryScope();
  const queryClient = useQueryClient();
  const [params] = useSearchParams();
  const highlightedId = params.get('approval');
  const queryKey = ['auth', scope, 'admin', 'operations-approvals'] as const;
  const query = useQuery({
    queryKey,
    queryFn: ({ signal }) => fetchOperationsApprovals(signal),
    enabled: Boolean(scope),
  });
  const decide = useMutation({
    mutationFn: (input: { id: string; decision: OperationsApprovalDecision }) =>
      decideOperationsApproval(input.id, input.decision),
    onSettled: () => queryClient.invalidateQueries({ queryKey }),
  });

  const approvals = query.data?.approvals ?? [];
  const pending = approvals.filter((a) => a.status === 'pending');
  const settled = approvals.filter((a) => a.status !== 'pending');
  const decidingFor = (id: string) =>
    decide.isPending && decide.variables?.id === id ? decide.variables.decision : null;

  const renderList = (items: OperationsActionApproval[]) => (
    <div className="divide-y divide-border-default">
      {items.map((approval) => (
        <ApprovalItem
          key={approval.id}
          approval={approval}
          highlighted={approval.id === highlightedId}
          deciding={decidingFor(approval.id)}
          onDecide={(decision) => decide.mutate({ id: approval.id, decision })}
        />
      ))}
    </div>
  );

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <div className="flex items-center justify-between gap-3 border-b border-border-default px-4 py-3">
          <span className="text-sm font-medium text-fg-primary">
            Waiting for you{pending.length > 0 ? ` (${pending.length})` : ''}
          </span>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void query.refetch()}
            disabled={query.isFetching}
          >
            Refresh
          </Button>
        </div>
        {decide.error && (
          <div role="alert" className="border-b border-border-default px-4 py-3">
            <Body className="text-danger-fg">{decide.error.message}</Body>
          </div>
        )}
        {query.isPending ? (
          <div className="flex justify-center p-8">
            <Spinner size="lg" />
          </div>
        ) : query.error && approvals.length === 0 ? (
          <div className="p-6 text-center">
            <Body className="text-danger-fg">{query.error.message}</Body>
            <Button
              size="sm"
              variant="secondary"
              className="mt-3"
              onClick={() => void query.refetch()}
            >
              Retry
            </Button>
          </div>
        ) : pending.length === 0 ? (
          <div className="p-8 text-center">
            <Body className="text-fg-muted">
              Nothing to approve. Operations agents ask here before they delete, restart, sleep or
              cancel anything.
            </Body>
          </div>
        ) : (
          renderList(pending)
        )}
      </Card>

      {settled.length > 0 && (
        <Card>
          <div className="border-b border-border-default px-4 py-3">
            <span className="text-sm font-medium text-fg-primary">Recent decisions</span>
          </div>
          {renderList(settled)}
        </Card>
      )}
    </div>
  );
}
