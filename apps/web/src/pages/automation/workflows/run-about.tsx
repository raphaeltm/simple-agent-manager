/**
 * About a run: its goal, who started it and from which chat, when SAM stops it, and every step
 * chat in one place. Shown beside the steps on wide screens and under them on phones.
 */
import type { WorkflowRunDetail } from '@simple-agent-manager/shared';
import { ChevronRight } from 'lucide-react';
import { Link } from 'react-router';

import { projectChatPath } from '../../../lib/automation-routes';
import { formatTimeFromNow } from '../../../lib/time-utils';
import { fullDate } from '../time';
import { Disclosure, KeyValues } from '../ui';
import { FoldedText } from './step-detail';
import { StepMark } from './ui';

function Heading({ children }: { children: string }) {
  return (
    <h3 className="m-0 text-xs font-semibold uppercase tracking-wider text-fg-muted">{children}</h3>
  );
}

export function RunAbout({
  run,
  projectId,
  personName,
}: {
  run: WorkflowRunDetail;
  projectId: string;
  personName: (userId: string) => string;
}) {
  const started = Date.parse(run.createdAt);
  const deadline = Date.parse(run.deadlineAt ?? '');
  const chats = run.steps.filter((step) => step.sessionId);
  const from = run.startedFrom;
  return (
    <section
      aria-label="About this run"
      className="flex min-w-0 flex-col gap-5"
      data-testid="workflow-run-about"
    >
      <div className="flex flex-col gap-2">
        <Heading>Goal</Heading>
        <FoldedText text={run.goal || 'No goal was given.'} lines={5} testId="workflow-run-goal" />
      </div>

      <div className="flex flex-col gap-2">
        <Heading>How it started</Heading>
        <p className="m-0 break-words text-sm text-fg-primary">
          Started by {personName(run.startedByUserId)}
          {Number.isFinite(started) ? ` · ${fullDate(started)}` : ''}
        </p>
        {from?.sessionId && (
          <Link
            to={projectChatPath(projectId, from.sessionId)}
            className="flex min-h-11 min-w-0 items-center gap-2 rounded-lg border border-solid border-border-default px-3 py-2 no-underline hover:bg-surface-hover"
          >
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="text-xs text-fg-muted">From the chat</span>
              <span className="line-clamp-2 break-words text-sm font-semibold text-fg-primary [overflow-wrap:anywhere]">
                {from.title?.trim() || 'Untitled chat'}
              </span>
            </span>
            <ChevronRight size={16} aria-hidden className="shrink-0 text-fg-muted" />
          </Link>
        )}
        {run.status === 'active' && Number.isFinite(deadline) && (
          <p className="m-0 text-sm text-fg-muted">
            SAM stops it if it is not done {formatTimeFromNow(deadline)} ({fullDate(deadline)}).
          </p>
        )}
        {run.maxParallelSteps !== null && run.steps.length > 1 && (
          <p className="m-0 text-sm text-fg-muted">
            At most {run.maxParallelSteps} {run.maxParallelSteps === 1 ? 'step runs' : 'steps run'}{' '}
            at once.
          </p>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <Heading>{`Agent chats (${chats.length})`}</Heading>
        {chats.length === 0 ? (
          <p className="m-0 text-sm text-fg-muted">Each step gets its own chat when it starts.</p>
        ) : (
          <ul className="m-0 flex list-none flex-col p-0">
            {chats.map((step) => (
              <li key={step.key}>
                <Link
                  to={projectChatPath(projectId, step.sessionId ?? '')}
                  className="flex min-h-11 min-w-0 items-center gap-2 rounded-md px-1 no-underline hover:bg-surface-hover"
                >
                  <StepMark step={step} size={16} />
                  <span className="min-w-0 flex-1 truncate text-sm text-fg-primary">
                    {step.title}
                  </span>
                  <ChevronRight size={16} aria-hidden className="shrink-0 text-fg-muted" />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <Heading>How workflows run</Heading>
        <p className="m-0 text-sm text-fg-muted">
          Each step is an ordinary agent chat. SAM starts a step once every step it needs has
          finished, and passes their summaries and references along. A failed step is not retried,
          and steps that need it do not start; to try again, ask an agent to start a new run.
        </p>
      </div>

      <Disclosure title="Advanced" hint="IDs for support and agents">
        <KeyValues rows={[['Run', run.id]]} mono />
      </Disclosure>
    </section>
  );
}
