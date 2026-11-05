import {
  OPERATIONS_ACTION_LABELS,
  OPERATIONS_IRREVERSIBLE_ACTIONS,
  type OperationsActionApproval,
  type OperationsApprovalDecision,
} from '@simple-agent-manager/shared';
import { Body, Button } from '@simple-agent-manager/ui';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

const STATUS_STYLES: Record<OperationsActionApproval['status'], { bg: string; text: string }> = {
  pending: { bg: 'var(--sam-color-warning-tint)', text: 'var(--sam-color-warning-fg)' },
  approved: { bg: 'var(--sam-color-success-tint)', text: 'var(--sam-color-success)' },
  executed: { bg: 'var(--sam-color-info-tint)', text: 'var(--sam-color-info-fg)' },
  denied: { bg: 'var(--sam-color-danger-tint)', text: 'var(--sam-color-danger-fg)' },
  expired: { bg: 'var(--sam-color-warning-tint)', text: 'var(--sam-color-fg-primary)' },
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

/**
 * True while the clamped reason hides text. Measured, not guessed from length: a short reason
 * with line breaks, or a narrow phone, can still exceed three lines.
 */
function useReasonClipped(reason: string, expanded: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  const [clipped, setClipped] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current?.firstElementChild;
    if (!el || expanded) return;
    const measure = () => setClipped(el.scrollHeight > el.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [reason, expanded]);
  return { ref, clipped };
}

function executionMessage(approval: OperationsActionApproval): string | null {
  const message = approval.executionResult?.message;
  return typeof message === 'string' ? message : null;
}

/**
 * One Operations approval: what the agent asked to do, why, and Approve / Deny while it is
 * pending. Shared by Admin → Approvals and the in-chat approval card.
 */
export function ApprovalItem({
  approval,
  highlighted = false,
  canDecide = true,
  deciding,
  onDecide,
}: {
  approval: OperationsActionApproval;
  highlighted?: boolean;
  /** False hides Approve / Deny (for example when the card is shown outside its project). */
  canDecide?: boolean;
  deciding: OperationsApprovalDecision | null;
  onDecide: (decision: OperationsApprovalDecision) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (highlighted) ref.current?.scrollIntoView({ block: 'center' });
  }, [highlighted]);
  const [reasonExpanded, setReasonExpanded] = useState(false);
  const reasonClamp = useReasonClipped(approval.reason, reasonExpanded);
  const pending = approval.status === 'pending';
  const irreversible = OPERATIONS_IRREVERSIBLE_ACTIONS.includes(approval.action);
  const result = executionMessage(approval);
  // Right under the request, so a long reason or target list never pushes them off a phone screen.
  const actions = (
    <div className="grid grid-cols-2 gap-3 sm:max-w-md">
      <Button
        variant={irreversible ? 'danger' : 'primary'}
        className="min-h-11"
        disabled={deciding !== null}
        loading={deciding === 'approve'}
        onClick={() => onDecide('approve')}
      >
        {deciding === 'approve' ? 'Approving…' : 'Approve'}
      </Button>
      <Button
        variant="secondary"
        className="min-h-11"
        disabled={deciding !== null}
        loading={deciding === 'deny'}
        onClick={() => onDecide('deny')}
      >
        {deciding === 'deny' ? 'Denying…' : 'Deny'}
      </Button>
    </div>
  );

  return (
    <div
      ref={ref}
      data-testid={`approval-${approval.id}`}
      className={`flex flex-col gap-3 px-4 py-4 ${highlighted ? 'ring-2 ring-inset ring-accent' : ''}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-fg-primary">
            {OPERATIONS_ACTION_LABELS[approval.action] ?? approval.action}
          </div>
          <div className="break-all font-mono text-xs text-fg-muted">
            {approval.targetType} {approval.targetId}
          </div>
        </div>
        <StatusChip status={approval.status} />
      </div>

      {irreversible && pending && (
        <div className="text-xs font-semibold text-danger-fg">
          ⚠ Cannot be undone: approving permanently deletes this {approval.targetType}.
        </div>
      )}
      <div ref={reasonClamp.ref}>
        <Body
          className={`whitespace-pre-wrap break-words text-sm ${reasonExpanded ? '' : 'line-clamp-3'}`}
        >
          {approval.reason}
        </Body>
        {(reasonExpanded || reasonClamp.clipped) && (
          <button
            type="button"
            className="mt-1 text-xs text-accent hover:underline"
            aria-expanded={reasonExpanded}
            onClick={() => setReasonExpanded((open) => !open)}
          >
            {reasonExpanded ? 'Show less' : 'Show more'}
          </button>
        )}
      </div>
      {pending && canDecide && actions}
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
          ? ` · decided ${formatTime(approval.decidedAt)}${approval.decidedBy ? ` by ${approval.decidedBy}` : ''}`
          : null}
        {approval.executedAt ? ` · executed ${formatTime(approval.executedAt)}` : null}
      </div>
      {result && <div className="break-words text-xs text-fg-primary">Result: {result}</div>}
    </div>
  );
}
