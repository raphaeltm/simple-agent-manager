/**
 * PROTOTYPE ONLY — step details. On desktop this is the right column of the
 * run page; on phones it is a bottom sheet. Approval steps show the upstream
 * evidence and Approve / Reject; only the owner can decide (agents cannot).
 */
import { Button } from '@simple-agent-manager/ui';
import {
  ArrowUpRight,
  BadgeCheck,
  Bot,
  CircleStop,
  Hand,
  RotateCcw,
  ShieldCheck,
  SkipForward,
  ThumbsDown,
  X,
} from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { Link } from 'react-router';

import { useIsMobile } from '../../hooks/useIsMobile';
import { PROFILES } from './mock-world';
import type { RunDef, RunFrame, StepDef } from './model';
import { p } from './shell';
import { EvidenceChip, Pill, STEP_META, StepIcon } from './status-ui';

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="m-0 text-[10px] font-semibold uppercase tracking-wider text-fg-muted">
        {title}
      </h3>
      {children}
    </section>
  );
}

const STEP_CHAT: Record<string, string> = {
  implement: p('b/step-chat'),
  fix: p('b/step-chat'),
  review: p('b/step-chat'),
  tests: p('b/step-chat'),
  growthbook: p('b/step-chat'),
};

function ApprovalBody({
  run,
  frame,
  step,
  onApprove,
  onReject,
}: {
  run: RunDef;
  frame: RunFrame;
  step: StepDef;
  onApprove: () => void;
  onReject: () => void;
}) {
  const isMobile = useIsMobile();
  const [comment, setComment] = useState('');
  const [noting, setNoting] = useState(false);
  const state = frame.steps[step.key];
  const upstream = run.steps.filter((s) => s.kind === 'agent' && frame.steps[s.key]?.summary);
  const pending = state?.status === 'needs_you';
  const next = run.steps.find((s) => s.after.includes(step.key));

  const decision = pending ? (
    <div
      className={
        isMobile
          ? 'sticky bottom-0 -mx-4 -mb-8 px-4 pt-3 pb-5 mt-1 flex flex-col gap-2'
          : 'flex flex-col gap-2'
      }
      style={
        isMobile
          ? {
              // Opaque on purpose: nested glass goes transparent, and evidence scrolls underneath.
              background: 'var(--sam-color-bg-surface)',
              borderTop: '1px solid var(--sam-color-border-default)',
              boxShadow: '0 -10px 18px -6px rgba(0, 0, 0, 0.45)',
            }
          : undefined
      }
      data-testid="approval-decision"
    >
      {noting && (
        <textarea
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          rows={2}
          placeholder="Note for the record, e.g. Ship after the 3pm standup"
          aria-label="Note for the record"
          className="w-full rounded-sm bg-[var(--sam-form-bg)] border border-[var(--sam-form-border)] px-3 py-2 text-sm text-fg-primary resize-y"
        />
      )}
      <div className="grid grid-cols-2 gap-2">
        <Button variant="secondary" onClick={onReject}>
          <ThumbsDown size={15} /> Reject
        </Button>
        <Button onClick={onApprove}>
          <BadgeCheck size={15} /> Approve
        </Button>
      </div>
      <p className="m-0 text-[11px] text-fg-muted leading-relaxed">
        Approve starts “{next?.title}”. Reject marks the run “Needs attention”.{' '}
        {!noting && (
          <button
            type="button"
            onClick={() => setNoting(true)}
            className="bg-transparent border-none p-0 text-accent text-[11px] cursor-pointer underline"
          >
            Add a note
          </button>
        )}
      </p>
    </div>
  ) : null;

  return (
    <>
      <div
        className="rounded-lg p-3 text-sm leading-relaxed"
        style={{
          background: 'color-mix(in srgb, var(--sam-color-warning) 10%, transparent)',
          border: '1px solid color-mix(in srgb, var(--sam-color-warning) 45%, transparent)',
          color: 'var(--sam-color-fg-primary)',
        }}
      >
        <div
          className="flex items-center gap-1.5 text-xs font-semibold mb-1"
          style={{ color: 'var(--sam-color-warning-fg)' }}
        >
          <Hand size={13} aria-hidden />{' '}
          {pending ? 'Your decision — only you can make it' : 'Decision'}
        </div>
        {step.question}
      </div>

      {!isMobile && decision}
      {!pending && state?.decidedBy && (
        <p className="m-0 text-sm text-fg-primary">
          {state.status === 'approved' ? 'Approved' : 'Rejected'} by {state.decidedBy}
          {state.comment ? ` — “${state.comment}”` : ''}
        </p>
      )}

      <Section title="What happened so far">
        <ul className="list-none m-0 p-0 flex flex-col gap-2">
          {upstream.map((s) => {
            const st = frame.steps[s.key];
            if (!st) return null;
            return (
              <li
                key={s.key}
                className="rounded-md border border-border-default px-2.5 py-2 bg-inset"
              >
                <div className="flex items-center gap-1.5 text-xs font-medium text-fg-primary">
                  <StepIcon status={st.status} size={13} /> {s.title}
                </div>
                <p className="m-0 mt-1 text-xs text-fg-muted leading-relaxed break-words line-clamp-3">
                  {st.summary}
                </p>
                {st.evidence && (
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {st.evidence.map((e) => (
                      <EvidenceChip key={e.label} e={e} />
                    ))}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
        <p className="m-0 text-[11px] text-fg-muted">
          <ShieldCheck size={11} className="inline -mt-0.5" aria-hidden /> = checked by SAM.
          Everything else is reported by the agent.
        </p>
      </Section>

      {isMobile && decision}
    </>
  );
}

function AgentBody({
  frame,
  step,
  run,
  onRetry,
  onSkip,
}: {
  frame: RunFrame;
  step: StepDef;
  run: RunDef;
  onRetry?: () => void;
  onSkip?: () => void;
}) {
  const state = frame.steps[step.key] ?? { status: 'waiting' as const };
  const profile = step.profileId ? PROFILES[step.profileId] : undefined;
  const hasChat = !['waiting', 'up_next', 'blocked'].includes(state.status) && state.started;
  const prereqs = run.steps.filter((s) => step.after.includes(s.key));
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(
    `${step.instructions}\n\nUse the GitHub README and the public pricing PDF instead of the docs site.`
  );

  return (
    <>
      <div className="flex flex-wrap gap-2">
        {hasChat ? (
          <Link
            to={STEP_CHAT[step.key] ?? p('b/step-chat')}
            className="inline-flex items-center gap-1.5 min-h-9 px-3 rounded-md text-sm font-semibold no-underline bg-accent text-fg-on-accent"
          >
            Open chat <ArrowUpRight size={14} />
          </Link>
        ) : (
          <span className="text-xs text-fg-muted">
            The chat appears here when this step starts.
          </span>
        )}
        {state.status === 'running' && (
          <Button size="sm" variant="ghost">
            <CircleStop size={14} /> Stop step
          </Button>
        )}
      </div>

      <Section title="Asked to">
        <p className="m-0 text-sm text-fg-primary leading-relaxed">{step.instructions}</p>
        {step.mustOpenPr && (
          <span className="inline-flex items-center gap-1 text-[11px] text-fg-muted">
            <ShieldCheck size={12} aria-hidden /> Must open a pull request to count as done
          </span>
        )}
      </Section>

      {prereqs.length > 0 && (
        <Section title="Gets from earlier steps">
          <p className="m-0 text-xs text-fg-muted leading-relaxed">
            Results from {prereqs.map((s) => `“${s.title}”`).join(' and ')} (summary, plus any PR,
            branch or files) go into this step’s first message, labelled as agent-written.
          </p>
        </Section>
      )}

      {state.summary && (
        <Section title={state.status === 'failed' ? 'What went wrong' : 'Result'}>
          <p className="m-0 text-sm text-fg-primary leading-relaxed break-words">{state.summary}</p>
          {state.evidence && (
            <div className="flex flex-wrap gap-1">
              {state.evidence.map((e) => (
                <EvidenceChip key={e.label} e={e} />
              ))}
            </div>
          )}
          {state.evidence && (
            <p className="m-0 text-[11px] text-fg-muted">
              <ShieldCheck size={11} className="inline -mt-0.5" aria-hidden /> = checked by SAM.
              Everything else is reported by the agent.
            </p>
          )}
        </Section>
      )}

      {state.attempts && state.attempts.length > 0 && (
        <Section title="Attempts">
          <ol className="list-none m-0 p-0 flex flex-col gap-1">
            {state.attempts.map((a) => (
              <li key={a.n} className="flex items-start gap-2 text-xs text-fg-muted">
                <span className="tabular-nums font-semibold text-fg-primary">#{a.n}</span>
                <span className="break-words">
                  {a.note}
                  {a.auto ? ' · automatic (machine problem)' : ''}
                </span>
              </li>
            ))}
          </ol>
        </Section>
      )}

      {state.status === 'failed' && (
        <Section title="What now">
          {editing ? (
            <div className="flex flex-col gap-2">
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                rows={4}
                className="w-full rounded-sm bg-[var(--sam-form-bg)] border border-[var(--sam-form-border)] px-3 py-2 text-sm text-fg-primary resize-y"
                aria-label="Instructions for the retry"
              />
              <div className="flex gap-2">
                <Button size="sm" onClick={onRetry}>
                  <RotateCcw size={14} /> Retry with these instructions
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={() => setEditing(true)}>
                <RotateCcw size={14} /> Retry with changes
              </Button>
              <Button size="sm" variant="secondary" onClick={onRetry}>
                Retry as is
              </Button>
              <Button size="sm" variant="ghost" onClick={onSkip}>
                <SkipForward size={14} /> Skip
              </Button>
            </div>
          )}
          <p className="m-0 text-[11px] text-fg-muted leading-relaxed">
            SAM only retries automatically when a machine fails. When an agent reports a problem,
            you decide. Skipping lets the next step run without this one.
          </p>
        </Section>
      )}

      {profile && (
        <p className="m-0 flex items-center gap-1.5 text-[11px] text-fg-muted">
          <Bot size={12} aria-hidden /> {profile.name} ·{' '}
          {profile.runtime === 'instant' ? 'Instant' : 'VM'} · an ordinary task in your name
        </p>
      )}
    </>
  );
}

export function StepPanel({
  run,
  frame,
  stepKey,
  onClose,
  onApprove,
  onReject,
  onRetry,
  onSkip,
}: {
  run: RunDef;
  frame: RunFrame;
  stepKey: string;
  onClose: () => void;
  onApprove: () => void;
  onReject: () => void;
  onRetry?: () => void;
  onSkip?: () => void;
}) {
  const step = run.steps.find((s) => s.key === stepKey);
  if (!step) return null;
  const state = frame.steps[step.key] ?? { status: 'waiting' as const };
  const meta = STEP_META[state.status];
  const number = run.steps.findIndex((s) => s.key === step.key) + 1;

  return (
    <div className="flex flex-col gap-4 min-w-0" data-testid="step-panel">
      <div className="flex items-start gap-2">
        <span className="pt-1">
          <StepIcon status={state.status} size={18} />
        </span>
        <div className="flex-1 min-w-0">
          <div className="text-[11px] text-fg-muted">
            Step {number} of {run.steps.length}
          </div>
          <h2 className="m-0 text-base font-semibold text-fg-primary leading-snug break-words">
            {step.title}
          </h2>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <Pill tone={meta.tone} icon={meta.icon} spin={meta.spin}>
              {meta.label}
            </Pill>
            {state.reason && (
              <span className="text-[11px] text-fg-muted break-words">{state.reason}</span>
            )}
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close step details"
          className="w-8 h-8 shrink-0 rounded-md flex items-center justify-center bg-transparent border border-border-default text-fg-muted cursor-pointer"
        >
          <X size={15} />
        </button>
      </div>
      {step.kind === 'approval' ? (
        <ApprovalBody
          run={run}
          frame={frame}
          step={step}
          onApprove={onApprove}
          onReject={onReject}
        />
      ) : (
        <AgentBody frame={frame} step={step} run={run} onRetry={onRetry} onSkip={onSkip} />
      )}
    </div>
  );
}
