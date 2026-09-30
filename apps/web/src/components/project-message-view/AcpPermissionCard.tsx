import { AcpInteractionOptionSchema, type AcpInteractionState } from '@simple-agent-manager/shared';
import { Button } from '@simple-agent-manager/ui';
import { AlertTriangle, Check, Clock3, RefreshCw, ShieldQuestion, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as v from 'valibot';

import {
  type AcpInteractionSnapshotItem,
  answerAcpInteraction,
  getAcpInteractionDetail,
} from '../../lib/api/acp-interactions';
import { ApiClientError } from '../../lib/api/client';

const DEADLINE_TICK_MS = 1_000;
const COLLAPSIBLE_DESCRIPTION_CHARS = 240;

type PermissionOption = v.InferOutput<typeof AcpInteractionOptionSchema>;

interface PermissionDetail {
  title: string;
  description: string | null;
  options: PermissionOption[];
}

type Submission = {
  answerKey: string;
  option: PermissionOption;
  answerHash: string;
  status: 'submitting' | 'accepted' | 'uncertain' | 'conflict' | 'revoked';
  message: string | null;
};

function parsePermissionDetail(value: Record<string, unknown> | null): PermissionDetail | null {
  if (!value || !Array.isArray(value.options) || value.options.length === 0) return null;
  const options: PermissionOption[] = [];
  const optionIds = new Set<string>();
  for (const candidate of value.options) {
    const parsed = v.safeParse(AcpInteractionOptionSchema, candidate);
    if (!parsed.success || optionIds.has(parsed.output.id)) return null;
    optionIds.add(parsed.output.id);
    options.push(parsed.output);
  }
  const titleCandidate = value.title ?? value.permissionName;
  const title =
    typeof titleCandidate === 'string' && titleCandidate.trim()
      ? titleCandidate
      : 'Permission request';
  const description =
    typeof value.description === 'string' && value.description.trim() ? value.description : null;
  return { title, description, options };
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
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

function statusCopy(state: AcpInteractionState): {
  label: string;
  description: string;
  tone: 'active' | 'success' | 'warning' | 'muted';
} {
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

export function AcpPermissionCard({
  interaction,
  projectId,
  sessionId,
  canAnswer,
  onRefresh,
}: {
  interaction: AcpInteractionSnapshotItem;
  projectId: string;
  sessionId: string;
  canAnswer: boolean;
  onRefresh: () => Promise<unknown>;
}) {
  const [detail, setDetail] = useState<PermissionDetail | null>(null);
  const [detailState, setDetailState] = useState<
    'idle' | 'loading' | 'ready' | 'error' | 'revoked'
  >('idle');
  const [detailNonce, setDetailNonce] = useState(0);
  const [submission, setSubmission] = useState<Submission | null>(null);
  const [descriptionExpanded, setDescriptionExpanded] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const requestedRefreshAfterDeadline = useRef(false);
  const isPending = interaction.state === 'pending';
  const deadlinePassed = isPending && now >= interaction.deadlineAt;

  useEffect(() => {
    if (!isPending) return;
    const timer = window.setInterval(() => setNow(Date.now()), DEADLINE_TICK_MS);
    return () => window.clearInterval(timer);
  }, [isPending]);

  useEffect(() => {
    if (!deadlinePassed || requestedRefreshAfterDeadline.current) return;
    requestedRefreshAfterDeadline.current = true;
    void onRefresh();
  }, [deadlinePassed, onRefresh]);

  useEffect(() => {
    if (!canAnswer || !isPending || deadlinePassed) {
      setDetail(null);
      setDetailState('idle');
      setDescriptionExpanded(false);
      return;
    }
    const controller = new AbortController();
    setDetail(null);
    setDetailState('loading');
    setDescriptionExpanded(false);
    void getAcpInteractionDetail(projectId, sessionId, interaction.interactionId, controller.signal)
      .then((response) => {
        const parsed = parsePermissionDetail(response.detail);
        setDetail(parsed);
        setDetailState(parsed ? 'ready' : 'error');
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setDetail(null);
        setDetailState(
          error instanceof ApiClientError && (error.status === 401 || error.status === 403)
            ? 'revoked'
            : 'error'
        );
      });
    return () => {
      controller.abort();
    };
  }, [
    canAnswer,
    deadlinePassed,
    detailNonce,
    interaction.interactionId,
    isPending,
    projectId,
    sessionId,
  ]);

  useEffect(() => {
    if (!isPending) {
      setDetail(null);
      setSubmission(null);
    }
  }, [isPending]);

  const submit = useCallback(
    async (next: Submission) => {
      setSubmission({ ...next, status: 'submitting', message: null });
      try {
        await answerAcpInteraction(projectId, sessionId, interaction.interactionId, {
          answerKey: next.answerKey,
          decision: {
            kind: 'selected_option',
            optionId: next.option.id,
            answerHash: next.answerHash,
          },
        });
        setSubmission({
          ...next,
          status: 'accepted',
          message: 'Answer saved. Checking delivery status…',
        });
        await onRefresh();
      } catch (error: unknown) {
        if (error instanceof ApiClientError && (error.status === 401 || error.status === 403)) {
          setDetail(null);
          setDetailState('revoked');
          setSubmission({
            ...next,
            status: 'revoked',
            message: 'Your access changed before the answer was accepted.',
          });
          return;
        }
        if (error instanceof ApiClientError && error.status === 409) {
          setSubmission({
            ...next,
            status: 'conflict',
            message: 'Another tab or user already answered this request. Refreshing…',
          });
          await onRefresh();
          return;
        }
        setSubmission({
          ...next,
          status: 'uncertain',
          message: 'The receipt was lost. Retry to check using the same answer key.',
        });
      }
    },
    [interaction.interactionId, onRefresh, projectId, sessionId]
  );

  const chooseOption = useCallback(
    async (option: PermissionOption) => {
      if (submission || deadlinePassed) return;
      const next: Submission = {
        option,
        answerKey: crypto.randomUUID(),
        answerHash: await sha256Hex(option.id),
        status: 'submitting',
        message: null,
      };
      await submit(next);
    },
    [deadlinePassed, submission, submit]
  );

  const status = useMemo(
    () => statusCopy(deadlinePassed ? 'expired' : interaction.state),
    [deadlinePassed, interaction.state]
  );
  const StatusIcon =
    status.tone === 'success'
      ? Check
      : status.tone === 'warning'
        ? AlertTriangle
        : status.tone === 'muted'
          ? X
          : ShieldQuestion;
  const statusClass =
    status.tone === 'success'
      ? 'bg-success/10 text-success'
      : status.tone === 'warning'
        ? 'bg-warning-tint text-warning-fg'
        : status.tone === 'muted'
          ? 'bg-surface text-fg-muted'
          : 'bg-accent/10 text-accent';

  return (
    <section
      className="mt-2 min-w-0 rounded-xl border border-warning/40 bg-warning-tint p-3 shadow-sm"
      aria-label="Permission request"
      data-testid={`acp-permission-${interaction.interactionId}`}
      data-interaction-state={deadlinePassed ? 'expired' : interaction.state}
    >
      <div className="flex min-w-0 items-start gap-2.5">
        <span
          className="mt-0.5 rounded-full bg-warning/15 p-1.5 text-warning-fg"
          aria-hidden="true"
        >
          <StatusIcon size={16} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <h3 className="break-words text-sm font-semibold text-fg-primary">
                {detail?.title ?? 'Permission request'}
              </h3>
              <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${statusClass}`}>
                {status.label}
              </span>
            </div>
            {isPending && !deadlinePassed && (
              <span className="inline-flex items-center gap-1 text-xs text-fg-muted">
                <Clock3 size={13} aria-hidden="true" />
                {formatRemaining(interaction.deadlineAt, now)}
              </span>
            )}
          </div>

          <p className="mt-1 break-words text-sm text-fg-secondary">
            {!canAnswer && isPending
              ? 'Waiting for the session creator to review this permission request.'
              : status.description}
          </p>

          {canAnswer && isPending && !deadlinePassed && (
            <div className="mt-3">
              {detailState === 'loading' && (
                <p className="text-xs text-fg-muted" role="status">
                  Loading secure details…
                </p>
              )}
              {detailState === 'revoked' && (
                <p className="text-sm text-danger" role="alert">
                  You no longer have access to view or answer this request.
                </p>
              )}
              {detailState === 'error' && (
                <div className="flex flex-wrap items-center gap-2" role="alert">
                  <p className="text-sm text-warning-fg">
                    Secure permission details are unavailable. No option was inferred.
                  </p>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => setDetailNonce((value) => value + 1)}
                  >
                    <RefreshCw size={14} aria-hidden="true" /> Retry details
                  </Button>
                </div>
              )}
              {detailState === 'ready' && detail && (
                <>
                  {detail.description && (
                    <div className="mb-3">
                      <p
                        className={`break-words text-sm text-fg-secondary ${
                          !descriptionExpanded &&
                          detail.description.length > COLLAPSIBLE_DESCRIPTION_CHARS
                            ? 'line-clamp-2'
                            : ''
                        }`}
                      >
                        {detail.description}
                      </p>
                      {detail.description.length > COLLAPSIBLE_DESCRIPTION_CHARS && (
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          className="mt-1"
                          onClick={() => setDescriptionExpanded((expanded) => !expanded)}
                          aria-expanded={descriptionExpanded}
                        >
                          {descriptionExpanded ? 'Hide details' : 'Show details'}
                        </Button>
                      )}
                    </div>
                  )}
                  <div className="flex min-w-0 flex-wrap gap-2" aria-label="Permission options">
                    {detail.options.map((option) => (
                      <Button
                        key={option.id}
                        type="button"
                        size="sm"
                        variant={option.kind.startsWith('reject') ? 'danger' : 'secondary'}
                        className="h-auto min-w-0 max-w-full !whitespace-normal break-words text-left"
                        disabled={submission !== null}
                        onClick={() => void chooseOption(option)}
                        data-option-id={option.id}
                      >
                        {option.name}
                      </Button>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}

          {submission?.message && (
            <div className="mt-3 flex flex-wrap items-center gap-2" role="status">
              <p
                className={
                  submission.status === 'revoked'
                    ? 'text-sm text-danger'
                    : 'text-sm text-fg-secondary'
                }
              >
                {submission.message}
              </p>
              {submission.status === 'uncertain' && (
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  onClick={() => void submit(submission)}
                >
                  Retry {submission.option.name}
                </Button>
              )}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
