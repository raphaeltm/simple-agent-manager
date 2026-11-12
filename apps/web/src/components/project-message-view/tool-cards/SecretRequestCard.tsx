import type { ToolCallItem } from '@simple-agent-manager/acp-client';
import type {
  RuntimeSecretRequest,
  RuntimeSecretRequestStatus,
} from '@simple-agent-manager/shared';
import { Button, Spinner } from '@simple-agent-manager/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound } from 'lucide-react';
import { type FC, useEffect, useMemo, useState } from 'react';

import { useQueryScope } from '../../../hooks/useQueryScope';
import { getSecretRequest } from '../../../lib/api';
import { projectQueryKeys } from '../../../lib/query-options/projects';
import { formatDateTime } from '../../../lib/time-utils';
import { extractSecretRequestId } from './secret-request-card-data';
import { SecretRequestForm } from './SecretRequestForm';

export interface SecretRequestCardProps {
  item: ToolCallItem;
  /** Project of the conversation; the request is read and answered within it. */
  projectId?: string;
}

/**
 * How often an open card re-reads a request that can still change (answered on another device,
 * or expired). TanStack pauses this while the tab is hidden. Override via
 * VITE_SECRET_REQUEST_CARD_REFRESH_MS.
 */
const DEFAULT_SECRET_REQUEST_CARD_REFRESH_MS = 15_000;
const configuredRefreshMs = Number.parseInt(
  import.meta.env.VITE_SECRET_REQUEST_CARD_REFRESH_MS ?? '',
  10
);
const SECRET_REQUEST_CARD_REFRESH_MS =
  Number.isFinite(configuredRefreshMs) && configuredRefreshMs > 0
    ? configuredRefreshMs
    : DEFAULT_SECRET_REQUEST_CARD_REFRESH_MS;

const CARD_CLASS = 'glass-surface my-1 rounded-md border border-border-default';

type Tone = 'open' | 'done' | 'muted';

const STATUS: Record<RuntimeSecretRequestStatus, { label: string; tone: Tone }> = {
  pending: { label: 'Waiting for a value', tone: 'open' },
  fulfilled: { label: 'Supplied', tone: 'done' },
  declined: { label: 'Declined', tone: 'muted' },
  expired: { label: 'Expired', tone: 'muted' },
};

/** A supplied value whose TTL has passed: the request was answered, the value is gone. */
const VALUE_EXPIRED_STATUS: { label: string; tone: Tone } = {
  label: 'Value expired',
  tone: 'muted',
};

const BADGE_CLASS: Record<Tone, string> = {
  open: 'bg-warning-tint text-warning-fg',
  done: 'bg-success/10 text-success',
  muted: 'bg-surface text-fg-muted',
};

function formatDuration(seconds: number): string {
  if (seconds % 86_400 === 0) return `${seconds / 86_400} day${seconds === 86_400 ? '' : 's'}`;
  if (seconds % 3_600 === 0) return `${seconds / 3_600} hour${seconds === 3_600 ? '' : 's'}`;
  if (seconds % 60 === 0) return `${seconds / 60} minute${seconds === 60 ? '' : 's'}`;
  return `${seconds} seconds`;
}

/** Longest delay `setTimeout` accepts; a later deadline is re-checked when this one fires. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * True once `deadline` (ISO) has passed, and flips on time while the card stays open, so a
 * supplied value's TTL is shown as expired without waiting for a reload or a refetch.
 */
function useDeadlinePassed(deadline: string | null): boolean {
  const deadlineMs = deadline ? Date.parse(deadline) : Number.NaN;
  const [passed, setPassed] = useState(() => deadlineMs <= Date.now());
  useEffect(() => {
    if (!Number.isFinite(deadlineMs)) {
      setPassed(false);
      return undefined;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = () => {
      const remaining = deadlineMs - Date.now();
      setPassed(remaining <= 0);
      if (remaining > 0) timer = setTimeout(check, Math.min(remaining, MAX_TIMER_DELAY_MS));
    };
    check();
    return () => clearTimeout(timer);
  }, [deadlineMs]);
  return passed;
}

function lifetimeText(request: RuntimeSecretRequest, valueExpired: boolean): string {
  if (request.secretExpiresAt) {
    return valueExpired
      ? `It expired ${formatDateTime(request.secretExpiresAt)} and can no longer be used.`
      : `Expires ${formatDateTime(request.secretExpiresAt)}.`;
  }
  return request.ttlSeconds
    ? `Expires ${formatDuration(request.ttlSeconds)} after it is saved.`
    : 'Kept until someone deletes it.';
}

function outcomeText(request: RuntimeSecretRequest, valueExpired: boolean): string {
  const by = request.resolvedByName ? ` by ${request.resolvedByName}` : '';
  const when = request.resolvedAt ? ` on ${formatDateTime(request.resolvedAt)}` : '';
  switch (request.status) {
    case 'fulfilled':
      return valueExpired
        ? `Supplied${by}${when}. The value has expired, so the agent can no longer use it. Ask the agent to request it again if it is still needed.`
        : `Supplied${by}${when}. The agent was told the name, never the value, and can use it until it expires or is deleted.`;
    case 'declined':
      return `Declined${by}${when}. The agent was told not to wait for it.`;
    case 'expired':
      return 'Nobody supplied a value in time. The agent was told not to wait for it.';
    case 'pending':
      return 'Waiting for a project owner or admin to supply the value.';
  }
}

/**
 * Renders a `request_secret` tool call as a secure input card. Everything shown comes from the
 * server's request record; the transcript supplies only the request ID. The value typed here goes
 * straight to the API and is stored encrypted as a project runtime secret: it never passes
 * through the agent, the chat, or the query cache.
 */
export const SecretRequestCard: FC<SecretRequestCardProps> = ({ item, projectId }) => {
  const requestId = useMemo(() => extractSecretRequestId(item), [item]);
  const scope = useQueryScope();
  const queryClient = useQueryClient();
  const queryKey = projectQueryKeys.secretRequest(scope, projectId ?? '', requestId ?? '');
  const query = useQuery({
    queryKey,
    queryFn: ({ signal }) => getSecretRequest(projectId as string, requestId as string, signal),
    enabled: Boolean(scope && projectId && requestId),
    retry: false,
    refetchInterval: (q) =>
      q.state.data?.request.status !== 'pending' || (q.state.error && !q.state.data)
        ? false
        : SECRET_REQUEST_CARD_REFRESH_MS,
  });
  // Which outcome was saved without the agent being confirmed told, so the warning names it.
  const [unconfirmedOutcome, setUnconfirmedOutcome] = useState<'fulfilled' | 'declined' | null>(
    null
  );
  const valueExpired = useDeadlinePassed(
    query.data?.request.status === 'fulfilled' ? query.data.request.secretExpiresAt : null
  );

  if (!requestId) return null;

  if (!projectId) {
    return (
      <div className={`${CARD_CLASS} flex items-center gap-2.5 px-3 py-2.5`} role="note">
        <KeyRound size={18} className="shrink-0 text-fg-muted" aria-hidden="true" />
        <div className="min-w-0 text-sm text-fg-muted">
          The agent asked for a secret. Open this chat in its project to supply it.
        </div>
      </div>
    );
  }

  const data = query.data;
  if (!data) {
    return (
      <div className={`${CARD_CLASS} flex items-center gap-2.5 px-3 py-2.5`}>
        {query.error ? (
          <>
            <div className="min-w-0 flex-1 text-sm text-danger-fg" role="alert">
              Couldn&apos;t load this secret request: {query.error.message}
            </div>
            <Button size="sm" variant="secondary" onClick={() => void query.refetch()}>
              Retry
            </Button>
          </>
        ) : (
          <div className="flex items-center gap-2.5" role="status">
            <Spinner size="sm" />
            <span className="text-sm text-fg-muted">Loading secret request…</span>
          </div>
        )}
      </div>
    );
  }

  const { request } = data;
  const status =
    request.status === 'fulfilled' && valueExpired ? VALUE_EXPIRED_STATUS : STATUS[request.status];

  return (
    <div className={`${CARD_CLASS} min-w-0`} data-testid="secret-request-card">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border-default px-4 py-2">
        <span className="flex min-w-0 items-center gap-2 text-sm font-semibold text-fg-primary">
          <KeyRound
            size={16}
            className={`shrink-0 ${status.tone === 'open' ? 'text-warning-fg' : 'text-fg-muted'}`}
            aria-hidden="true"
          />
          Secret requested
        </span>
        <span
          className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${BADGE_CLASS[status.tone]}`}
        >
          {status.label}
        </span>
      </div>
      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2 px-4 py-3">
        <code className="w-fit max-w-full rounded-sm bg-inset px-1.5 py-0.5 text-[0.8125rem] font-semibold text-fg-primary [overflow-wrap:anywhere]">
          {request.envKey}
        </code>
        {/* Agent-written text: shown as plain text, never as markup. */}
        <p className="m-0 whitespace-pre-wrap text-sm text-fg-primary [overflow-wrap:anywhere]">
          {request.reason}
        </p>
        {(request.status === 'pending' || request.status === 'fulfilled') && (
          <p className="m-0 text-xs text-fg-muted">
            {request.status === 'pending'
              ? 'Saved encrypted as a project secret, never shown to the agent or this chat. '
              : 'Stored encrypted as a project secret. '}
            {valueExpired
              ? lifetimeText(request, true)
              : `Every project member’s agent sessions can use it. ${lifetimeText(request, false)}`}
          </p>
        )}
      </div>
      <div className="min-w-0 border-t border-border-default px-4 py-3">
        {data.canResolve ? (
          <SecretRequestForm
            projectId={projectId}
            request={request}
            existing={data.existing}
            onResolved={(resolution) => {
              const outcome = resolution.request.status;
              setUnconfirmedOutcome(
                !resolution.agentNotified && (outcome === 'fulfilled' || outcome === 'declined')
                  ? outcome
                  : null
              );
              queryClient.setQueryData(queryKey, {
                ...data,
                request: resolution.request,
                canResolve: false,
              });
              void queryClient.invalidateQueries({
                queryKey: projectQueryKeys.runtimeConfig(scope, projectId),
              });
            }}
          />
        ) : (
          <p role="status" className="m-0 text-sm text-fg-muted [overflow-wrap:anywhere]">
            {outcomeText(request, valueExpired)}
            {request.status === 'pending' && ` Open until ${formatDateTime(request.expiresAt)}.`}
          </p>
        )}
        {unconfirmedOutcome && (
          <p role="alert" className="m-0 mt-2 text-sm text-warning-fg [overflow-wrap:anywhere]">
            {unconfirmedOutcome === 'fulfilled'
              ? `Saved, but SAM could not confirm the agent was told. Tell it in this chat that ${request.envKey} is ready.`
              : `Declined, but SAM could not confirm the agent was told. Tell it in this chat not to wait for ${request.envKey}.`}
          </p>
        )}
      </div>
    </div>
  );
};
