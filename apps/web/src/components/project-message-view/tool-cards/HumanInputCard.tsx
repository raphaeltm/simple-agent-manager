import type { ToolCallItem } from '@simple-agent-manager/acp-client';
import { Button, Spinner } from '@simple-agent-manager/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { HelpCircle } from 'lucide-react';
import { type FC, useMemo, useState } from 'react';

import { useQueryScope } from '../../../hooks/useQueryScope';
import {
  type AttentionRequestContext,
  getAttentionRequestContext,
} from '../../../lib/api/notifications';
import { notificationQueryKeys } from '../../../lib/query-options';
import { RenderedMarkdown } from '../../MarkdownRenderer';
import { AttentionAnswerControls } from '../../notifications/AttentionAnswerControls';
import { extractHumanInputRequest } from './human-input-card-data';

export interface HumanInputCardProps {
  item: ToolCallItem;
  /** Project of the conversation; the question is read and answered within it. */
  projectId?: string;
}

/**
 * How often an open card re-reads a question that can still change (answered from the
 * notification bell or another tab, delivered, or expired). TanStack pauses this while the tab
 * is hidden. Override via VITE_HUMAN_INPUT_CARD_REFRESH_MS.
 */
const DEFAULT_HUMAN_INPUT_CARD_REFRESH_MS = 15_000;
const configuredRefreshMs = Number.parseInt(
  import.meta.env.VITE_HUMAN_INPUT_CARD_REFRESH_MS ?? '',
  10
);
const HUMAN_INPUT_CARD_REFRESH_MS =
  Number.isFinite(configuredRefreshMs) && configuredRefreshMs > 0
    ? configuredRefreshMs
    : DEFAULT_HUMAN_INPUT_CARD_REFRESH_MS;

/** Questions longer than this start collapsed, so a long brief does not bury the buttons. */
const COLLAPSIBLE_QUESTION_CHARS = 600;

const CARD_CLASS = 'glass-surface my-1 rounded-md border border-border-default';

type Request = AttentionRequestContext['request'];
type Tone = 'open' | 'done' | 'muted';

/** Same wording as the bell's title (`notifyNeedsInput`): "Approval needed", "Input needed". */
function titleFor(request: Request): string {
  const category = request.category;
  const label = category
    ? category.charAt(0).toUpperCase() + category.slice(1).replaceAll('_', ' ')
    : 'Input';
  return `${label} needed`;
}

function statusFor(request: Request): { label: string; tone: Tone } {
  if (request.resolvedAt !== null) return { label: 'Answered', tone: 'done' };
  if (request.resolvedAnswer !== null) return { label: 'Answer being delivered', tone: 'done' };
  if (request.expired) return { label: 'Expired', tone: 'muted' };
  return { label: 'Needs your answer', tone: 'open' };
}

function isSettled(request: Request | undefined): boolean {
  return Boolean(request && (request.resolvedAt !== null || request.expired));
}

const BADGE_CLASS: Record<Tone, string> = {
  open: 'bg-warning-tint text-warning-fg',
  done: 'bg-success/10 text-success',
  muted: 'bg-surface text-fg-muted',
};

function settledText(request: Request): string {
  if (request.resolvedAt !== null) {
    return request.resolvedAnswer
      ? `Answered: ${request.resolvedAnswer}`
      : 'This question has already been resolved.';
  }
  if (request.resolvedAnswer !== null) {
    return `Answer is being delivered: ${request.resolvedAnswer}`;
  }
  if (request.expired) return 'This question has expired.';
  return 'Waiting for the session owner to answer.';
}

function QuestionText({ reason }: { reason: string | null }) {
  const [expanded, setExpanded] = useState(false);
  const text = reason || 'No question text was saved for this request.';
  const collapsible = text.length > COLLAPSIBLE_QUESTION_CHARS;
  return (
    <div className="px-4 pt-3">
      <div
        className={`min-w-0 text-sm [overflow-wrap:anywhere] ${collapsible && !expanded ? 'max-h-40 overflow-hidden [mask-image:linear-gradient(to_bottom,black_65%,transparent)]' : ''}`}
      >
        <RenderedMarkdown inline content={text} />
      </div>
      {collapsible && (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="mt-1"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
        >
          {expanded ? 'Show less' : 'Show full question'}
        </Button>
      )}
    </div>
  );
}

/**
 * Renders a `request_human_input` tool call as the question it created, so the user can answer
 * it in the conversation instead of only from the notification bell. Everything shown comes
 * from the server's attention marker; the transcript supplies only its ID. Answers go through
 * the same endpoint as the bell and reach the agent as a new prompt.
 */
export const HumanInputCard: FC<HumanInputCardProps> = ({ item, projectId }) => {
  const ref = useMemo(() => extractHumanInputRequest(item), [item]);
  const scope = useQueryScope();
  const queryClient = useQueryClient();
  const queryKey = notificationQueryKeys.attentionRequest(
    scope,
    projectId ?? '',
    ref?.sessionId ?? '',
    ref?.id ?? ''
  );
  const query = useQuery({
    queryKey,
    queryFn: ({ signal }) =>
      getAttentionRequestContext(
        projectId as string,
        ref?.sessionId as string,
        ref?.id as string,
        false,
        signal
      ),
    enabled: Boolean(scope && projectId && ref),
    retry: false,
    // A question that is settled cannot change; one that failed to load (gone, or access
    // revoked) waits for Retry instead of polling an error forever.
    refetchInterval: (q) =>
      isSettled(q.state.data?.request) || (q.state.error && !q.state.data)
        ? false
        : HUMAN_INPUT_CARD_REFRESH_MS,
  });

  if (!ref) return null;

  if (!projectId) {
    return (
      <div className={`${CARD_CLASS} flex items-center gap-2.5 px-3 py-2.5`} role="note">
        <HelpCircle size={18} className="shrink-0 text-fg-muted" aria-hidden="true" />
        <div className="min-w-0 text-sm text-fg-muted">
          The agent asked for your input. Answer it from the notification bell.
        </div>
      </div>
    );
  }

  const request = query.data?.request;

  if (!request) {
    return (
      <div className={`${CARD_CLASS} flex items-center gap-2.5 px-3 py-2.5`}>
        {query.error ? (
          <>
            <div className="min-w-0 flex-1 text-sm text-danger-fg" role="alert">
              Couldn&apos;t load this question: {query.error.message}
            </div>
            <Button size="sm" variant="secondary" onClick={() => void query.refetch()}>
              Retry
            </Button>
          </>
        ) : (
          <div className="flex items-center gap-2.5" role="status">
            <Spinner size="sm" />
            <span className="text-sm text-fg-muted">Loading question…</span>
          </div>
        )}
      </div>
    );
  }

  const status = statusFor(request);

  return (
    <div className={CARD_CLASS} data-testid="human-input-card">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border-default px-4 py-2">
        <span className="flex min-w-0 items-center gap-2 text-sm font-semibold text-fg-primary">
          <HelpCircle
            size={16}
            className={`shrink-0 ${status.tone === 'open' ? 'text-warning-fg' : 'text-fg-muted'}`}
            aria-hidden="true"
          />
          {titleFor(request)}
        </span>
        <span
          className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${BADGE_CLASS[status.tone]}`}
        >
          {status.label}
        </span>
      </div>
      <QuestionText reason={request.reason} />
      <div className="px-4 pb-3 pt-3">
        {request.canAnswer ? (
          <AttentionAnswerControls
            key={request.id}
            projectId={projectId}
            sessionId={ref.sessionId}
            markerId={request.id}
            options={request.options}
            allowCustom
            onResolved={() => void queryClient.invalidateQueries({ queryKey })}
          />
        ) : (
          <p role="status" className="text-sm text-fg-muted [overflow-wrap:anywhere]">
            {settledText(request)}
          </p>
        )}
      </div>
    </div>
  );
};
