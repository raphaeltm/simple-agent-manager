/**
 * One step, in full: what it was asked to do, what it got from the steps before it, what it
 * produced, and where its chat is. Everything an agent wrote is labelled as reported by the
 * agent; SAM's own state (status, times, attempts) is shown without that label.
 */
import type {
  CompletionEvidence,
  WorkflowRunDetail,
  WorkflowStepDetail,
} from '@simple-agent-manager/shared';
import { CircleCheck, CircleX } from 'lucide-react';
import { useState } from 'react';

import { projectChatPath } from '../../../lib/automation-routes';
import { fullDate } from '../time';
import { ButtonLink, Disclosure, KeyValues } from '../ui';
import { artifactLink, branchLink, pullRequestLink } from './links';
import { blockingStep, explainStep, stepDuration } from './model';
import { OutputChip, StepBadge, StepMark, TONE_COLOR } from './ui';

/** Long agent-written text, folded to a few lines until asked for. */
export function FoldedText({
  text,
  lines = 4,
  testId,
}: {
  text: string;
  lines?: number;
  testId?: string;
}) {
  const [open, setOpen] = useState(false);
  const long = text.length > lines * 90 || text.split('\n').length > lines;
  return (
    <div className="flex flex-col gap-1">
      <p
        data-testid={testId}
        className="m-0 whitespace-pre-wrap break-words text-sm text-fg-primary [overflow-wrap:anywhere]"
        style={
          long && !open
            ? {
                display: '-webkit-box',
                WebkitBoxOrient: 'vertical',
                WebkitLineClamp: lines,
                overflow: 'hidden',
              }
            : undefined
        }
      >
        {text}
      </p>
      {long && (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          className="min-h-11 w-fit cursor-pointer rounded-md border-0 bg-transparent px-0 text-sm font-semibold text-accent"
        >
          {open ? 'Show less' : 'Show all'}
        </button>
      )}
    </div>
  );
}

function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex min-w-0 flex-col gap-2" aria-label={title}>
      <div className="flex flex-col">
        <h3 className="m-0 text-xs font-semibold uppercase tracking-wider text-fg-muted">
          {title}
        </h3>
        {hint && <p className="m-0 text-xs text-fg-muted">{hint}</p>}
      </div>
      {children}
    </section>
  );
}

/** Links to everything a step reported: pull request, branch, and published references. */
export function StepOutputs({ step, projectId }: { step: WorkflowStepDetail; projectId: string }) {
  const output = step.output;
  if (!output) return null;
  const links = [
    ...(output.prUrl ? [pullRequestLink(output.prUrl)] : []),
    ...(output.branch ? [branchLink(output.branch)] : []),
    ...output.handoffs.flatMap((handoff) =>
      handoff.artifactRefs.map((ref) => artifactLink(ref, projectId))
    ),
  ];
  if (!links.length) return null;
  return (
    <div className="flex flex-col gap-2">
      {links.map((link, index) => (
        <OutputChip key={`${link.kind}:${link.detail}:${index}`} link={link} />
      ))}
    </div>
  );
}

function Evidence({ evidence }: { evidence: CompletionEvidence }) {
  const tests = evidence.testsRun ?? [];
  const checks = evidence.verifications ?? [];
  if (!tests.length && !checks.length && !evidence.notes) return null;
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-solid border-border-default p-3">
      {tests.map((test, index) => (
        <div key={`test-${index}`} className="flex items-start gap-2 text-sm">
          {test.passed ? (
            <CircleCheck size={16} aria-hidden className="mt-0.5 shrink-0 text-success-fg" />
          ) : (
            <CircleX size={16} aria-hidden className="mt-0.5 shrink-0 text-danger-fg" />
          )}
          <span className="min-w-0 break-words font-mono text-[13px] text-fg-primary [overflow-wrap:anywhere]">
            <span className="sr-only">{test.passed ? 'Passed: ' : 'Failed: '}</span>
            {test.command}
          </span>
        </div>
      ))}
      {checks.map((check, index) => (
        <p
          key={`check-${index}`}
          className="m-0 break-words text-sm text-fg-primary [overflow-wrap:anywhere]"
        >
          {check.description}
        </p>
      ))}
      {evidence.notes && <FoldedText text={evidence.notes} lines={3} />}
    </div>
  );
}

/** What the step's prerequisites passed to it. */
function Inputs({
  step,
  run,
  projectId,
  onSelect,
}: {
  step: WorkflowStepDetail;
  run: WorkflowRunDetail;
  projectId: string;
  onSelect: (key: string) => void;
}) {
  const parents = step.after
    .map((key) => run.steps.find((candidate) => candidate.key === key))
    .filter((parent): parent is WorkflowStepDetail => Boolean(parent));
  if (!parents.length) return null;
  return (
    <Section
      title="What it gets from earlier steps"
      hint="Each finished step's summary and references are passed to this step's agent as agent-written text. Long summaries are shortened."
    >
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {parents.map((parent) => (
          <li
            key={parent.key}
            className="flex flex-col gap-2 rounded-lg border border-solid border-border-default p-3"
          >
            <button
              type="button"
              onClick={() => onSelect(parent.key)}
              className="-m-1 flex min-h-11 cursor-pointer items-center gap-2 rounded-md border-0 bg-transparent p-1 text-left"
            >
              <StepMark step={parent} size={16} />
              <span className="min-w-0 flex-1 break-words text-sm font-semibold text-fg-primary [overflow-wrap:anywhere]">
                {parent.title}
              </span>
            </button>
            {parent.output?.summary ? (
              <FoldedText text={parent.output.summary} lines={3} />
            ) : (
              <p className="m-0 text-sm text-fg-muted">
                {parent.status === 'completed' ? 'No summary.' : 'Not finished yet.'}
              </p>
            )}
            <StepOutputs step={parent} projectId={projectId} />
          </li>
        ))}
      </ul>
    </Section>
  );
}

function WaitDetails({ step }: { step: WorkflowStepDetail }) {
  const wait = step.wait;
  if (!wait) return null;
  const rows: Array<[string, React.ReactNode]> = [['Waits for', wait.description]];
  if (wait.eventTypes.length) rows.push(['Event', wait.eventTypes.join(', ')]);
  if (wait.subject) rows.push(['About', `${wait.subject.type} ${wait.subject.id}`]);
  if (wait.listeningSince)
    rows.push(['Listening since', fullDate(Date.parse(wait.listeningSince))]);
  if (wait.timeoutAt)
    rows.push([wait.timedOut ? 'Gave up at' : 'Gives up at', fullDate(Date.parse(wait.timeoutAt))]);
  if (wait.matchedEvent)
    rows.push([
      'Heard',
      `${wait.matchedEvent.title ?? wait.matchedEvent.eventType} · ${fullDate(Date.parse(wait.matchedEvent.occurredAt))}`,
    ]);
  return (
    <Section title="What it waits for">
      <KeyValues rows={rows} />
    </Section>
  );
}

export function StepDetail({
  run,
  step,
  projectId,
  onSelect,
}: {
  run: WorkflowRunDetail;
  step: WorkflowStepDetail;
  projectId: string;
  onSelect: (key: string) => void;
}) {
  const number = run.steps.findIndex((candidate) => candidate.key === step.key) + 1;
  const explanation = explainStep(step, run);
  const blocker = blockingStep(step, run.steps);
  const took = step.status === 'running' || step.status === 'starting' ? stepDuration(step) : null;
  const chat = step.sessionId ? projectChatPath(projectId, step.sessionId) : null;
  const pr = step.output?.prUrl ? pullRequestLink(step.output.prUrl) : null;
  const advanced: Array<[string, React.ReactNode]> = [
    ['Step key', step.key],
    ['Attempt', step.attemptId],
  ];
  if (step.taskId) advanced.push(['Task', step.taskId]);
  if (step.sessionId) advanced.push(['Chat', step.sessionId]);
  if (step.taskStatus) advanced.push(['Task status', step.taskStatus.replaceAll('_', ' ')]);
  if (step.agent?.agentType)
    advanced.push(['Agent', [step.agent.agentType, step.agent.model].filter(Boolean).join(' · ')]);
  if (step.launchAttempts) advanced.push(['Start attempts', String(step.launchAttempts)]);
  if (step.startedAt) advanced.push(['Started', fullDate(Date.parse(step.startedAt))]);
  if (step.finishedAt) advanced.push(['Finished', fullDate(Date.parse(step.finishedAt))]);

  return (
    <article
      data-testid="workflow-step-detail"
      aria-label={`Step ${number}: ${step.title}`}
      className="flex min-w-0 flex-col gap-5"
    >
      <header className="flex flex-col gap-2">
        <span className="text-xs font-semibold uppercase tracking-wider text-fg-muted">
          Step {number} of {run.steps.length}
          {step.kind === 'wait' ? ' · waits for an event' : ''}
        </span>
        <h2 className="m-0 break-words text-[19px] font-semibold leading-snug text-fg-primary [overflow-wrap:anywhere]">
          {step.title}
        </h2>
        <div className="flex flex-wrap items-center gap-2 text-[13px] text-fg-muted">
          <StepBadge step={step} />
          {step.agent && (
            <span className="break-words">{step.agent.profileName ?? 'Agent profile'}</span>
          )}
          {took && <span>· {took}</span>}
        </div>
        <p
          data-testid="workflow-step-explanation"
          className="m-0 break-words text-sm [overflow-wrap:anywhere]"
          style={{ color: explanation.tone === 'muted' ? undefined : TONE_COLOR[explanation.tone] }}
        >
          {explanation.text}
        </p>
        {(chat || pr || blocker) && (
          <div className="flex flex-wrap gap-2 pt-1">
            {chat && (
              <ButtonLink to={chat} variant="primary">
                Open the chat
              </ButtonLink>
            )}
            {pr?.href && (
              <a
                href={pr.href}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex min-h-11 items-center rounded-md border border-solid border-border-default px-4 text-[0.95rem] font-semibold text-fg-primary no-underline hover:bg-surface-hover"
              >
                Open the pull request
              </a>
            )}
            {blocker && (
              <button
                type="button"
                onClick={() => onSelect(blocker.key)}
                className="inline-flex min-h-11 cursor-pointer items-center rounded-md border border-solid border-border-default bg-transparent px-4 text-[0.95rem] font-semibold text-fg-primary hover:bg-surface-hover"
              >
                See the step that failed
              </button>
            )}
          </div>
        )}
      </header>

      <WaitDetails step={step} />

      {step.instructions.trim() && (
        <Section
          title="What it was asked to do"
          hint="Written by the agent that planned this workflow."
        >
          <FoldedText text={step.instructions} testId="workflow-step-instructions" />
        </Section>
      )}

      <Inputs step={step} run={run} projectId={projectId} onSelect={onSelect} />

      {step.output && (
        <Section title="What it produced" hint="Reported by the step's agent.">
          {step.output.summary ? (
            <FoldedText text={step.output.summary} lines={6} testId="workflow-step-summary" />
          ) : (
            <p className="m-0 text-sm text-fg-muted">No summary.</p>
          )}
          <StepOutputs step={step} projectId={projectId} />
          {step.output.evidence && <Evidence evidence={step.output.evidence} />}
        </Section>
      )}

      <Disclosure title="Advanced" hint="IDs for support and agents">
        <KeyValues rows={advanced} mono />
      </Disclosure>
    </article>
  );
}
