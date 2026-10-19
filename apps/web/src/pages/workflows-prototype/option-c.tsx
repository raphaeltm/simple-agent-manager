/**
 * PROTOTYPE ONLY — Option C, "Runbooks and run timelines" (run-centric).
 * Saved workflows are runnable markdown documents in the Library; each run is
 * a timeline read like a chat, with decisions inline; Home shows runs across
 * projects. No new project nav item.
 */
import { Breadcrumb, Button } from '@simple-agent-manager/ui';
import { BadgeCheck, Bot, FileText, Hand, History, Play, ThumbsDown } from 'lucide-react';
import { type ReactNode, useLayoutEffect, useRef } from 'react';
import { useNavigate } from 'react-router';

import { RenderedMarkdown } from '../../components/MarkdownRenderer';
import { useIsMobile } from '../../hooks/useIsMobile';
import { ChatLayout, SessionRows } from './chat-layout';
import { CSV_RUN } from './mock-runs-code-change';
import { RESEARCH_RUN } from './mock-runs-research';
import { RUNS } from './mock-workflows';
import { NON_STEP_SESSIONS, PROFILES } from './mock-world';
import { countSteps, frameAt, progressSentence } from './model';
import { RunListRow } from './option-a';
import { p, ProjectPage, ProtoShell } from './shell';
import { EvidenceChip, RunStatusPill, STEP_META, StepIcon, StepProgressBar } from './status-ui';

function SamLine({ at, children, tone }: { at: string; children: ReactNode; tone?: string }) {
  return (
    <div className="flex items-start gap-2 text-xs text-fg-muted">
      <span className="tabular-nums shrink-0 w-10 pt-0.5">{at}</span>
      <span
        className="shrink-0 mt-1 w-1.5 h-1.5 rounded-full"
        style={{ background: tone ?? 'var(--sam-color-fg-muted)' }}
      />
      <span className="break-words leading-relaxed">{children}</span>
    </div>
  );
}

function StepEvent({ k }: { k: string }) {
  const run = CSV_RUN;
  const frame = frameAt(run, null);
  const step = run.steps.find((s) => s.key === k);
  const st = frame.steps[k];
  if (!step || !st) return null;
  const n = run.steps.indexOf(step) + 1;
  return (
    <div className="glass-surface rounded-lg border border-border-default px-3 py-2.5 sm:max-w-[80%]">
      <div className="flex items-center gap-2">
        <StepIcon status={st.status} size={15} />
        <span className="text-sm font-medium text-fg-primary flex-1 min-w-0 truncate">
          <span className="text-fg-muted tabular-nums mr-1">{n}</span>
          {step.title}
        </span>
        <span className="text-[11px] text-fg-muted shrink-0">{st.duration}</span>
      </div>
      <div className="mt-1 text-[11px] text-fg-muted flex items-center gap-1.5">
        <Bot size={11} /> {step.profileId ? PROFILES[step.profileId]?.name : ''} ·{' '}
        <span style={{ color: STEP_META[st.status].color }}>{STEP_META[st.status].label}</span>
      </div>
      {st.summary && (
        <p className="m-0 mt-1.5 text-xs text-fg-primary leading-relaxed break-words">
          {st.summary}
        </p>
      )}
      {st.evidence && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {st.evidence.map((e) => (
            <EvidenceChip key={e.label} e={e} />
          ))}
        </div>
      )}
    </div>
  );
}

function ProgressRail() {
  const frame = frameAt(CSV_RUN, null);
  return (
    <aside
      className="w-[220px] shrink-0 glass-chrome border-y-0 border-r-0 p-3 overflow-y-auto"
      aria-label="Run progress"
    >
      <div className="text-[10px] font-semibold uppercase tracking-wider text-fg-muted mb-2">
        Steps
      </div>
      <ol className="list-none m-0 p-0 relative">
        <span
          className="absolute left-[7px] top-2 bottom-2 w-px bg-[var(--sam-color-border-default)]"
          aria-hidden
        />
        {CSV_RUN.steps.map((s, i) => {
          const st = frame.steps[s.key]?.status ?? 'waiting';
          return (
            <li key={s.key} className="relative flex items-start gap-2 py-1.5">
              <span className="relative z-10 bg-[var(--sam-color-bg-canvas)] rounded-full">
                <StepIcon status={st} size={15} />
              </span>
              <span className="text-xs leading-snug min-w-0">
                <span className={st === 'waiting' ? 'text-fg-muted' : 'text-fg-primary'}>
                  {i + 1}. {s.title}
                </span>
                {(s.key === 'review' || s.key === 'tests') && (
                  <span className="block text-[10px] text-fg-muted">in parallel</span>
                )}
              </span>
            </li>
          );
        })}
      </ol>
    </aside>
  );
}

export function OptionCRun() {
  const isMobile = useIsMobile();
  const navigate = useNavigate();
  const run = CSV_RUN;
  const frame = frameAt(run, null);
  const counts = countSteps(frame, run.steps);
  const feedRef = useRef<HTMLDivElement>(null);
  // Read like a chat: open at the latest event, where the decision is waiting.
  useLayoutEffect(() => {
    if (feedRef.current) feedRef.current.scrollTop = feedRef.current.scrollHeight;
  }, []);
  const rows = (
    <SessionRows
      sessions={NON_STEP_SESSIONS}
      selectedId={null}
      onSelect={() => navigate(p('b/chat'))}
      before={[CSV_RUN, RESEARCH_RUN].map((r) => (
        <RunListRow key={r.id} run={r} selected={r.id === CSV_RUN.id} onSelect={() => undefined} />
      ))}
    />
  );
  return (
    <ChatLayout option="C" label="Option C · a run read as a timeline" rows={rows}>
      <div className="flex-1 min-h-0 flex">
        <div className="flex-1 min-w-0 flex flex-col">
          <div className="shrink-0 px-4 py-2.5 glass-chrome border-x-0 border-t-0">
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-sm font-semibold text-fg-primary truncate flex-1">
                {run.title}
              </span>
              <RunStatusPill status={frame.status} />
            </div>
            <div className="mt-1 text-[11px] text-fg-muted truncate">
              Runbook “code-change-with-review.md” v3 · started by you 1h 12m ago
            </div>
            <StepProgressBar steps={run.steps} frame={frame} className="mt-2" />
            <div className="mt-1 text-[11px] text-fg-muted">{progressSentence(counts)}</div>
          </div>
          <div
            ref={feedRef}
            className="flex-1 min-h-0 overflow-y-auto px-4 py-4 flex flex-col gap-3"
            data-scroll-target
          >
            <SamLine at="09:18">Started from the runbook with your two blanks filled in.</SamLine>
            <StepEvent k="plan" />
            <SamLine at="09:31" tone="var(--sam-color-success)">
              Plan done → started “Implement the change”.
            </SamLine>
            <StepEvent k="implement" />
            <SamLine at="09:47" tone="var(--sam-color-success)">
              PR #482 opened → started review and staging tests together.
            </SamLine>
            <SamLine at="09:52" tone="var(--sam-color-warning)">
              Staging tests lost their machine — retried automatically.
            </SamLine>
            <StepEvent k="review" />
            <StepEvent k="tests" />
            <SamLine at="10:15" tone="var(--sam-color-success)">
              Both done → started “Fix review findings”.
            </SamLine>
            <StepEvent k="fix" />
            <div
              className="rounded-lg px-3 py-3 sm:max-w-[80%] flex flex-col gap-2"
              style={{
                background: 'color-mix(in srgb, var(--sam-color-warning) 10%, transparent)',
                border: '1px solid color-mix(in srgb, var(--sam-color-warning) 50%, transparent)',
              }}
            >
              <div
                className="flex items-center gap-1.5 text-xs font-semibold"
                style={{ color: 'var(--sam-color-warning-fg)' }}
              >
                <Hand size={13} /> 6 · Your approval
              </div>
              <div className="text-sm text-fg-primary">
                Check the PR, the review findings and the staging results. Merge to main?
              </div>
              <div className="flex gap-2">
                <Button size="sm" variant="secondary">
                  <ThumbsDown size={13} /> Reject
                </Button>
                <Button size="sm">
                  <BadgeCheck size={13} /> Approve
                </Button>
              </div>
            </div>
          </div>
          <div className="shrink-0 glass-chrome border-x-0 border-b-0 px-4 py-3 flex flex-wrap items-center gap-2">
            <Button size="sm" variant="secondary">
              Pause
            </Button>
            <Button size="sm" variant="ghost">
              Cancel run
            </Button>
            <span className="text-[11px] text-fg-muted ml-auto">
              A run has no agent of its own — decisions happen here.
            </span>
          </div>
        </div>
        {!isMobile && <ProgressRail />}
      </div>
    </ChatLayout>
  );
}

const RUNBOOK_MD = `# Code change with review & tests

Plan, implement with a test, review and test on staging in parallel, fix findings, then merge after your approval.

**Blanks:** \`What should change?\` (required) · \`How we’ll know it’s fixed\`

## Steps

1. **Plan the change** — *Brainstormer* — reproduce it and write a plan. No code changes.
2. **Implement the change** — *Codex 5.5 High* — new branch, regression test, open a PR. *(must open a PR)*
3. **Review the code** — *Picky CTO* — after 2, in parallel with 4.
4. **Run tests on staging** — *Claude Code — Opus 5* — after 2, in parallel with 3.
5. **Fix review findings** — *Codex 5.5 High* — after 3 and 4.
6. ✋ **Your approval: merge?** — waits for you.
7. **Merge and watch the deploy** — *Codex 5.5 High* — after your approval.
`;

export function OptionCRunbook() {
  const isMobile = useIsMobile();
  return (
    <ProtoShell
      option="C"
      active="library"
      label="Option C · a saved workflow is a runbook document"
    >
      <ProjectPage>
        <div className="flex flex-col gap-3 min-w-0">
          <Breadcrumb
            segments={[
              { label: 'Library', path: p('c/runbook') },
              { label: 'runbooks', path: p('c/runbook') },
              { label: 'code-change-with-review.md' },
            ]}
          />
          <div className="flex flex-col sm:flex-row sm:items-center gap-2">
            <div className="flex items-center gap-2 flex-1 min-w-0">
              <FileText size={18} className="text-fg-muted shrink-0" />
              <div className="min-w-0">
                <div className="text-sm font-semibold text-fg-primary truncate">
                  code-change-with-review.md
                </div>
                <div className="text-[11px] text-fg-muted">
                  Runbook · v3 · edited 2 days ago by you · used 14×
                </div>
              </div>
            </div>
            <div className="flex gap-2">
              <Button size="sm">
                <Play size={14} /> Run this
              </Button>
              <Button size="sm" variant="secondary">
                <History size={14} /> History
              </Button>
            </div>
          </div>
          <div
            className={
              isMobile
                ? 'flex flex-col gap-3'
                : 'grid grid-cols-[minmax(0,1fr)_280px] gap-5 items-start'
            }
          >
            <div className="rounded-lg border border-border-default bg-[color-mix(in_srgb,var(--sam-color-bg-surface)_70%,transparent)] min-w-0">
              <RenderedMarkdown content={RUNBOOK_MD} />
            </div>
            <div className="rounded-lg border border-border-default p-3 flex flex-col gap-2 min-w-0">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-fg-muted">
                Recent runs
              </div>
              {RUNS.filter(
                (r) => r.origin.kind === 'saved' && r.origin.workflowId === 'code-change'
              ).map((r) => {
                const f = frameAt(r, null);
                return (
                  <div key={r.id} className="flex flex-col gap-1">
                    <div className="flex items-center gap-2 text-xs">
                      <span className="truncate flex-1 text-fg-primary">{r.title}</span>
                      <RunStatusPill status={f.status} />
                    </div>
                    <StepProgressBar steps={r.steps} frame={f} height={4} />
                  </div>
                );
              })}
              <p className="m-0 text-[11px] text-fg-muted leading-relaxed">
                Agents can write and edit runbooks like any Library file. A file in the repo
                (.sam/workflows) could sync here later.
              </p>
            </div>
          </div>
        </div>
      </ProjectPage>
    </ProtoShell>
  );
}

export function OptionCHome() {
  const isMobile = useIsMobile();
  const groups: { project: string; runs: typeof RUNS }[] = [
    { project: 'Payments API', runs: RUNS.slice(0, 3) },
    { project: 'Merchant Portal', runs: RUNS.slice(5, 7) },
  ];
  return (
    <ProtoShell
      option="C"
      active="home"
      scope="global"
      label="Option C · Home shows runs across projects"
    >
      <div className="max-w-[80rem] w-full mx-auto px-4 sm:px-8 py-6 flex flex-col gap-5">
        <h1 className="sam-type-page-title m-0">Welcome, Priya!</h1>
        <section className="flex flex-col gap-2">
          <h2 className="m-0 sam-type-section-heading">Runs</h2>
          <p className="m-0 text-xs text-fg-muted">
            Everything in steps, across your projects. Needs-you first.
          </p>
          {groups.map((g) => (
            <div key={g.project} className="flex flex-col gap-2">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-fg-muted mt-2">
                {g.project}
              </div>
              <div className={`grid gap-3 ${isMobile ? 'grid-cols-1' : 'grid-cols-3'}`}>
                {g.runs.map((r) => {
                  const f = frameAt(r, null);
                  return (
                    <div
                      key={r.id}
                      className="glass-surface rounded-lg border border-border-default p-3 flex flex-col gap-2 min-w-0"
                    >
                      <div className="flex items-start gap-2">
                        <span className="text-sm font-medium text-fg-primary line-clamp-2 break-words flex-1">
                          {r.title}
                        </span>
                        <RunStatusPill status={f.status} />
                      </div>
                      <StepProgressBar steps={r.steps} frame={f} />
                      <div className="text-[11px] text-fg-muted">
                        {progressSentence(countSteps(f, r.steps))}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </section>
        <section className="flex flex-col gap-2">
          <h2 className="m-0 sam-type-section-heading">Active Tasks</h2>
          <p className="m-0 text-xs text-fg-muted">(today’s dashboard section continues below)</p>
        </section>
      </div>
    </ProtoShell>
  );
}
