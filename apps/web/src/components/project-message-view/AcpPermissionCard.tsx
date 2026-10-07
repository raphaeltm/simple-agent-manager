import type { AcpInteractionState } from '@simple-agent-manager/shared';
import { Button } from '@simple-agent-manager/ui';
import { AlertTriangle, Check, Clock3, RefreshCw, ShieldQuestion, X } from 'lucide-react';
import { useState } from 'react';

import type { AcpInteractionSnapshotItem } from '../../lib/api/acp-interactions';
import {
  type PermissionDetail,
  type PermissionOption,
  type Submission,
  useAcpPermissionCard,
} from './useAcpPermissionCard';

const COLLAPSIBLE_DESCRIPTION_CHARS = 240;

type Status = {
  label: string;
  description: string;
  tone: 'active' | 'success' | 'warning' | 'muted';
};

interface AcpPermissionCardProps {
  interaction: AcpInteractionSnapshotItem;
  projectId: string;
  sessionId: string;
  canAnswer: boolean;
  onRefresh: () => Promise<unknown>;
}

function statusCopy(state: AcpInteractionState): Status {
  switch (state) {
    case 'answered':
      return {
        label: 'Answer saved',
        description: 'Cloudflare accepted the answer and is delivering it to the live agent.',
        tone: 'active',
      };
    case 'delivery_confirmed':
      return {
        label: 'Delivered to agent',
        description: 'The live permission request consumed the saved answer.',
        tone: 'success',
      };
    case 'delivery_unconfirmed':
      return {
        label: 'Delivery unconfirmed',
        description:
          'The answer is saved, but delivery to the live request could not be confirmed.',
        tone: 'warning',
      };
    case 'interrupted':
      return {
        label: 'Request interrupted',
        description: 'The live agent request ended before it could consume an answer.',
        tone: 'warning',
      };
    case 'expired':
      return {
        label: 'Request expired',
        description: 'The permission deadline passed without an accepted answer.',
        tone: 'muted',
      };
    case 'cancelled':
      return {
        label: 'Request cancelled',
        description: 'The agent cancelled this permission request.',
        tone: 'muted',
      };
    default:
      return {
        label: 'Permission needed',
        description: 'Choose one of the exact options supplied by the agent.',
        tone: 'active',
      };
  }
}

function formatRemaining(deadlineAt: number, now: number): string {
  const seconds = Math.max(0, Math.ceil((deadlineAt - now) / 1_000));
  if (seconds < 60) return `${seconds}s remaining`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `${minutes}m remaining`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? `${hours}h ${remainder}m remaining` : `${hours}h remaining`;
}

function PermissionStatusHeader({
  status,
  title,
  remaining,
}: {
  status: Status;
  title: string;
  remaining?: string;
}) {
  const Icon =
    status.tone === 'success'
      ? Check
      : status.tone === 'warning'
        ? AlertTriangle
        : status.tone === 'muted'
          ? X
          : ShieldQuestion;
  const badgeClass =
    status.tone === 'success'
      ? 'bg-success/10 text-success'
      : status.tone === 'warning'
        ? 'bg-warning-tint text-warning-fg'
        : status.tone === 'muted'
          ? 'bg-surface text-fg-muted'
          : 'bg-accent/10 text-accent';
  return (
    <>
      <span className="mt-0.5 rounded-full bg-warning/15 p-1.5 text-warning-fg" aria-hidden="true">
        <Icon size={16} />
      </span>
      <div className="flex min-w-0 flex-1 flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <h3 className="min-w-0 max-w-full [overflow-wrap:anywhere] text-sm font-semibold text-fg-primary">{title}</h3>
          <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${badgeClass}`}>
            {status.label}
          </span>
        </div>
        {remaining && (
          <span className="inline-flex items-center gap-1 text-xs text-fg-muted">
            <Clock3 size={13} aria-hidden="true" />
            {remaining}
          </span>
        )}
      </div>
    </>
  );
}

function PermissionDescription({ detail }: { detail: PermissionDetail }) {
  const [expanded, setExpanded] = useState(false);
  if (!detail.description) return null;
  const collapsible = detail.description.length > COLLAPSIBLE_DESCRIPTION_CHARS;
  return (
    <div className="mb-3">
      <p
        className={`break-words text-sm text-fg-secondary ${!expanded && collapsible ? 'line-clamp-2' : ''}`}
      >
        {detail.description}
      </p>
      {collapsible && (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="mt-1"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
        >
          {expanded ? 'Hide details' : 'Show details'}
        </Button>
      )}
    </div>
  );
}

function PermissionOptions({
  options,
  disabled,
  onChoose,
}: {
  options: PermissionOption[];
  disabled: boolean;
  onChoose: (option: PermissionOption) => void;
}) {
  return (
    <div
      className="flex min-w-0 flex-wrap gap-2 pr-14 sm:pr-0"
      aria-label="Permission options"
      data-testid="acp-permission-options"
    >
      {options.map((option) => (
        <Button
          key={option.id}
          type="button"
          size="sm"
          variant={option.kind.startsWith('reject') ? 'danger' : 'secondary'}
          className="h-auto min-h-11 min-w-0 max-w-full !whitespace-normal break-words text-left"
          disabled={disabled}
          onClick={() => onChoose(option)}
          data-option-id={option.id}
        >
          {option.name}
        </Button>
      ))}
    </div>
  );
}

function PermissionDetails({
  state,
  detail,
  submission,
  choiceLocked,
  onRetry,
  onChoose,
}: {
  state: 'idle' | 'loading' | 'ready' | 'error' | 'revoked';
  detail: PermissionDetail | null;
  submission: Submission | null;
  choiceLocked: boolean;
  onRetry: () => void;
  onChoose: (option: PermissionOption) => void;
}) {
  if (state === 'loading')
    return (
      <p className="text-xs text-fg-muted" role="status">
        Loading secure details…
      </p>
    );
  if (state === 'revoked')
    return (
      <p className="text-sm text-danger" role="alert">
        You no longer have access to view or answer this request.
      </p>
    );
  if (state === 'error')
    return (
      <div className="flex flex-wrap items-center gap-2 pr-12 sm:pr-0" role="alert">
        <p className="text-sm text-warning-fg">
          Secure permission details are unavailable. No option was inferred.
        </p>
        <Button type="button" size="sm" variant="ghost" onClick={onRetry}>
          <RefreshCw size={14} aria-hidden="true" /> Retry details
        </Button>
      </div>
    );
  if (state !== 'ready' || !detail) return null;
  return (
    <>
      <PermissionDescription detail={detail} />
      <PermissionOptions
        options={detail.options}
        disabled={submission !== null || choiceLocked}
        onChoose={onChoose}
      />
    </>
  );
}

function SubmissionStatus({
  submission,
  onRetry,
  disabled,
}: {
  submission: Submission | null;
  onRetry: (submission: Submission) => void;
  disabled: boolean;
}) {
  if (!submission?.message) return null;
  return (
    <div
      className="mt-3 flex flex-wrap items-center gap-2 pr-12 sm:pr-0"
      role="status"
      data-testid="acp-permission-submission-status"
    >
      <p
        className={
          submission.status === 'revoked' ? 'text-sm text-danger' : 'text-sm text-fg-secondary'
        }
      >
        {submission.message}
      </p>
      {submission.status === 'uncertain' && (
        <Button
          type="button"
          size="sm"
          variant="secondary"
          className="h-auto min-h-11 min-w-0 max-w-full !whitespace-normal break-words text-left"
          aria-label={`Retry ${submission.option.name}`}
          disabled={disabled}
          onClick={() => onRetry(submission)}
        >
          Retry answer
        </Button>
      )}
    </div>
  );
}

function PermissionCardContent({
  card,
  canAnswer,
  status,
}: {
  card: ReturnType<typeof useAcpPermissionCard>;
  canAnswer: boolean;
  status: Status;
}) {
  return (
    <div className="ml-9 min-w-0">
      <p
        className="mt-1 break-words pr-12 text-sm text-fg-secondary sm:pr-0"
        data-testid="acp-permission-status-description"
      >
        {!canAnswer && card.isPending
          ? 'Waiting for the session creator to review this permission request.'
          : status.description}
      </p>
      {card.mayReveal && (
        <div className="mt-3">
          <PermissionDetails
            state={card.detailState}
            detail={card.secureDetail}
            submission={card.submission}
            choiceLocked={card.choiceLocked}
            onRetry={card.retryDetail}
            onChoose={(option) => void card.chooseOption(option)}
          />
        </div>
      )}
      {card.mayReveal && card.choiceError && (
        <p className="mt-3 pr-12 text-sm text-danger sm:pr-0" role="alert">
          {card.choiceError}
        </p>
      )}
      {card.mayReveal && (
        <SubmissionStatus
          submission={card.submission}
          disabled={card.submissionLocked}
          onRetry={(submission) => void card.submit(submission)}
        />
      )}
    </div>
  );
}

export function AcpPermissionCard(props: AcpPermissionCardProps) {
  const { interaction, canAnswer } = props;
  const card = useAcpPermissionCard(props);
  const state = card.deadlinePassed ? 'expired' : interaction.state;
  const status = statusCopy(state);
  const remaining =
    card.isPending && !card.deadlinePassed
      ? formatRemaining(interaction.deadlineAt, card.now)
      : undefined;
  return (
    <section
      className="mt-2 min-w-0 rounded-xl border border-warning/40 bg-warning-tint p-3 shadow-sm"
      aria-label="Permission request"
      data-testid={`acp-permission-${interaction.interactionId}`}
      data-tool-call-id={interaction.toolCallId ?? undefined}
      data-interaction-state={state}
    >
      <div className="flex min-w-0 items-start gap-2.5">
        <PermissionStatusHeader
          status={status}
          title={card.secureDetail?.title ?? 'Permission request'}
          remaining={remaining}
        />
      </div>
      <PermissionCardContent card={card} canAnswer={canAnswer} status={status} />
    </section>
  );
}
