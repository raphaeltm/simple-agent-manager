import { eligibleAcpUrl } from '@simple-agent-manager/shared';
import { Button } from '@simple-agent-manager/ui';
import { ExternalLink, Link2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import {
  type AcpInteractionSnapshotItem,
  answerAcpInteraction,
  getAcpInteractionDetail,
} from '../../lib/api/acp-interactions';

interface Props {
  interaction: AcpInteractionSnapshotItem;
  projectId: string;
  sessionId: string;
  canAnswer: boolean;
  onRefresh: () => Promise<unknown>;
}

type UrlDetail = { message: string; url: string; host: string };
type Receipt = {
  answerKey: string;
  decision: { kind: 'accepted' | 'declined'; answerHash: string };
};
const COLLAPSIBLE_MESSAGE_CHARS = 240;

function parseDetail(value: Record<string, unknown> | null): UrlDetail | null {
  if (!value || typeof value.message !== 'string' || typeof value.url !== 'string') return null;
  const eligible = eligibleAcpUrl(value.url);
  return eligible ? { message: value.message, url: value.url, host: eligible.host } : null;
}

async function decisionReceipt(kind: 'accepted' | 'declined'): Promise<Receipt> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(kind));
  const answerHash = [...new Uint8Array(digest)]
    .map((part) => part.toString(16).padStart(2, '0'))
    .join('');
  return { answerKey: crypto.randomUUID(), decision: { kind, answerHash } };
}

export function AcpUrlCard({ interaction, projectId, sessionId, canAnswer, onRefresh }: Props) {
  const [detail, setDetail] = useState<UrlDetail | null>(null);
  const [detailState, setDetailState] = useState<'idle' | 'loading' | 'error' | 'revoked'>('idle');
  const [opened, setOpened] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const decisionInFlight = useRef(false);
  const authority = useRef({
    projectId,
    sessionId,
    interactionId: interaction.interactionId,
    canAnswer,
    state: interaction.state,
    deadlineAt: interaction.deadlineAt,
    opened,
    mounted: true,
  });
  authority.current = {
    projectId,
    sessionId,
    interactionId: interaction.interactionId,
    canAnswer,
    state: interaction.state,
    deadlineAt: interaction.deadlineAt,
    opened,
    mounted: authority.current.mounted,
  };
  const pending = interaction.state === 'pending' && interaction.deadlineAt > Date.now();
  const mayReveal =
    canAnswer &&
    interaction.deadlineAt > Date.now() &&
    ['pending', 'answered', 'delivery_confirmed', 'delivery_unconfirmed'].includes(
      interaction.state
    );

  useEffect(() => {
    authority.current.mounted = true;
    return () => {
      authority.current.mounted = false;
    };
  }, []);

  useEffect(() => {
    if (!mayReveal) {
      setDetail(null);
      setOpened(false);
      setReceipt(null);
      setError(null);
      return;
    }
    const controller = new AbortController();
    setDetailState('loading');
    void getAcpInteractionDetail(
      projectId,
      sessionId,
      interaction.interactionId,
      controller.signal
    ).then(
      (response) => {
        if (controller.signal.aborted) return;
        const next = parseDetail(response.detail);
        setDetail(next);
        setDetailState(next ? 'idle' : 'error');
      },
      (failure: unknown) => {
        if (controller.signal.aborted) return;
        const status = failure instanceof Error && 'status' in failure ? failure.status : undefined;
        setDetail(null);
        setDetailState(status === 401 || status === 403 ? 'revoked' : 'error');
      }
    );
    return () => controller.abort();
  }, [interaction.interactionId, mayReveal, projectId, sessionId]);

  const currentAuthority = useCallback(
    (retry: boolean) => {
      const current = authority.current;
      return (
        current.mounted &&
        current.projectId === projectId &&
        current.sessionId === sessionId &&
        current.interactionId === interaction.interactionId &&
        current.canAnswer &&
        current.deadlineAt > Date.now() &&
        (current.state === 'pending' || (retry && current.state === 'answered'))
      );
    },
    [interaction.interactionId, projectId, sessionId]
  );

  const submit = useCallback(
    async (next: Receipt, retry = false) => {
      if (!currentAuthority(retry) || (saving && !retry)) return;
      setSaving(true);
      setError(null);
      setReceipt(next);
      try {
        await answerAcpInteraction(projectId, sessionId, interaction.interactionId, next);
        if (currentAuthority(retry)) await onRefresh();
      } catch (failure: unknown) {
        if (!currentAuthority(retry)) return;
        const status = failure instanceof Error && 'status' in failure ? failure.status : undefined;
        if (status === 409) {
          setReceipt(null);
          setError('This request changed in another tab. Refreshing…');
          await onRefresh();
        } else if (status === 401 || status === 403) {
          setDetail(null);
          setReceipt(null);
          setDetailState('revoked');
        } else setError('Receipt unknown. Check it with the same answer key.');
      } finally {
        if (currentAuthority(retry)) setSaving(false);
      }
    },
    [currentAuthority, interaction.interactionId, onRefresh, projectId, saving, sessionId]
  );

  const choose = useCallback(
    async (kind: 'accepted' | 'declined') => {
      const starting = authority.current;
      if (
        decisionInFlight.current ||
        !currentAuthority(false) ||
        (kind === 'accepted' && !starting.opened)
      )
        return;
      decisionInFlight.current = true;
      try {
        const next = await decisionReceipt(kind);
        if (!currentAuthority(false) || (kind === 'accepted' && !authority.current.opened)) return;
        await submit(next);
      } finally {
        decisionInFlight.current = false;
      }
    },
    [currentAuthority, submit]
  );

  const retryReceipt = useCallback(async () => {
    if (decisionInFlight.current || !receipt) return;
    decisionInFlight.current = true;
    try {
      await submit(receipt, true);
    } finally {
      decisionInFlight.current = false;
    }
  }, [receipt, submit]);

  const complete = interaction.urlCompletedAt != null;
  return (
    <section
      className="my-3 min-w-0 scroll-mt-36 rounded-xl border border-border bg-surface p-3 shadow-sm sm:p-4"
      data-testid={`acp-url-${interaction.interactionId}`}
    >
      <div className="flex min-w-0 items-start gap-3">
        <span className="rounded-full bg-accent/10 p-2 text-accent" aria-hidden="true">
          <Link2 size={18} />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-fg-primary">External service request</h3>
          <p className="text-xs text-fg-muted" role="status">
            {complete
              ? 'The external service reported completion.'
              : interaction.state === 'pending'
                ? 'Review the destination before opening it.'
                : interaction.state === 'delivery_confirmed'
                  ? 'Your decision reached the agent. External completion is still unconfirmed.'
                  : interaction.state === 'answered'
                    ? 'Your decision was saved. Delivery is pending.'
                    : `Request ${interaction.state.replaceAll('_', ' ')}. External completion is unconfirmed.`}
          </p>
          {pending && (
            <p className="mt-1 text-xs text-fg-muted">
              Deadline {new Date(interaction.deadlineAt).toLocaleString()}
            </p>
          )}
        </div>
      </div>
      {pending && !canAnswer && (
        <p className="mt-3 text-sm text-fg-muted">Waiting for the session creator to respond.</p>
      )}
      {mayReveal && detailState === 'loading' && (
        <p className="mt-3 text-sm text-fg-muted">Loading secure link…</p>
      )}
      {mayReveal && detailState === 'error' && (
        <p className="mt-3 text-sm text-danger" role="alert">
          This link cannot be displayed. Refresh the chat to try again.
        </p>
      )}
      {mayReveal && detailState === 'revoked' && (
        <p className="mt-3 text-sm text-danger" role="alert">
          Access to this request was revoked.
        </p>
      )}
      {mayReveal && detail && (
        <div className="mt-3 min-w-0 space-y-3">
          <div>
            <p className="break-words text-sm text-fg-secondary">
              {expanded || detail.message.length <= COLLAPSIBLE_MESSAGE_CHARS
                ? detail.message
                : `${detail.message.slice(0, COLLAPSIBLE_MESSAGE_CHARS)}…`}
            </p>
            {detail.message.length > COLLAPSIBLE_MESSAGE_CHARS && (
              <button
                type="button"
                className="mt-1 min-h-9 text-xs text-accent underline underline-offset-2"
                onClick={() => setExpanded((value) => !value)}
              >
                {expanded ? 'Show less' : 'Show full request'}
              </button>
            )}
          </div>
          <p className="break-all text-sm font-medium text-fg-primary">
            Destination: {detail.host}
          </p>
          <p className="text-xs text-fg-muted">
            Open the link, then choose Continue to let the agent proceed. The external service
            reports completion separately.
          </p>
          <a
            href={detail.url}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => setOpened(true)}
            className="inline-flex max-w-full min-h-14 items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm text-accent underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-accent"
          >
            <ExternalLink size={16} className="shrink-0" aria-hidden="true" />
            <span className="min-w-0 break-all text-balance">Open {detail.host}</span>
          </a>
          {error && (
            <p className="text-sm text-danger" role="alert">
              {error}
            </p>
          )}
          {pending && (
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                className="min-h-14"
                disabled={!opened || saving || !!receipt}
                onClick={() => void choose('accepted')}
              >
                Continue after opening
              </Button>
              <Button
                type="button"
                variant="secondary"
                className="min-h-14"
                disabled={saving || !!receipt}
                onClick={() => void choose('declined')}
              >
                Decline
              </Button>
              {receipt && error?.startsWith('Receipt unknown') && (
                <Button
                  type="button"
                  variant="secondary"
                  className="min-h-14"
                  disabled={saving}
                  onClick={() => void retryReceipt()}
                >
                  Check receipt
                </Button>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
