/**
 * PROTOTYPE ONLY — Option B: /projects/:id/workflows (Runs) and
 * /projects/:id/workflows/saved (Saved). One project nav item; runs that need
 * the owner float to the top.
 */
import { Button, Dialog, EmptyState } from '@simple-agent-manager/ui';
import { Bookmark, ChevronRight, MessageSquare, Play, Sparkles } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { Link, useNavigate } from 'react-router';

import { useIsMobile } from '../../hooks/useIsMobile';
import { RUNS, SAVED_WORKFLOWS } from './mock-workflows';
import { frameAt } from './model';
import { useParam } from './proto-controls';
import { p, ProjectPage, ProtoShell } from './shell';
import { RunCard, SavedCard, ShapeStrip } from './workflow-cards';

function Section({
  title,
  count,
  tone,
  children,
}: {
  title: string;
  count: number;
  tone?: string;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2 min-w-0">
      <h2
        className="m-0 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider"
        style={{ color: tone ?? 'var(--sam-color-fg-muted)' }}
      >
        {title}
        <span className="rounded-full px-1.5 py-px text-[10px] bg-[var(--sam-color-bg-inset)] text-fg-muted">
          {count}
        </span>
      </h2>
      {children}
    </section>
  );
}

export function StartPicker({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  return (
    <Dialog isOpen={isOpen} onClose={onClose} maxWidth="md" aria-labelledby="start-picker-title">
      <div className="p-5 flex flex-col gap-3">
        <h2 id="start-picker-title" className="m-0 text-base font-semibold text-fg-primary">
          Start a workflow
        </h2>
        <ul className="list-none m-0 p-0 flex flex-col gap-1.5">
          {SAVED_WORKFLOWS.slice(0, 4).map((wf) => (
            <li key={wf.id}>
              <button
                type="button"
                onClick={() => navigate(p(`b/workflows/saved/${wf.id}/start`))}
                className="w-full text-left flex items-center gap-3 rounded-md border border-dashed border-[var(--sam-form-border)] bg-transparent px-3 py-2.5 cursor-pointer hover:border-accent/50"
              >
                <Bookmark size={15} className="text-fg-muted shrink-0" />
                <span className="flex-1 min-w-0">
                  <span className="block text-sm text-fg-primary truncate">{wf.name}</span>
                  <span className="block text-[11px] text-fg-muted">
                    {wf.steps.length} steps · v{wf.version}
                  </span>
                </span>
                <ShapeStrip steps={wf.steps} size={9} />
                <ChevronRight size={15} className="text-fg-muted shrink-0" />
              </button>
            </li>
          ))}
        </ul>
        <Link
          to={p('b/new-chat')}
          className="flex items-center gap-3 rounded-md border border-border-default px-3 py-2.5 no-underline hover:border-accent/50"
        >
          <Sparkles size={15} style={{ color: 'var(--sam-color-info)' }} className="shrink-0" />
          <span className="flex-1 min-w-0">
            <span className="block text-sm text-fg-primary">Something new</span>
            <span className="block text-[11px] text-fg-muted">
              Describe it in chat. Your agent drafts the steps and starts a one-off run.
            </span>
          </span>
          <MessageSquare size={15} className="text-fg-muted shrink-0" />
        </Link>
      </div>
    </Dialog>
  );
}

export function WorkflowsHome({ tab }: { tab: 'runs' | 'saved' }) {
  const isMobile = useIsMobile();
  const [picker, setPicker] = useState(false);
  const [empty] = useParam('empty');
  const frames = RUNS.map((r) => ({ run: r, status: frameAt(r, null).status }));
  const needsYou = frames.filter((f) => f.status === 'needs_you' || f.status === 'needs_attention');
  const active = frames.filter((f) => ['running', 'paused', 'draft'].includes(f.status));
  const finished = frames.filter((f) => ['done', 'cancelled'].includes(f.status));
  const saved = empty ? [] : SAVED_WORKFLOWS;

  return (
    <ProtoShell
      option="B"
      active="workflows"
      label={`Option B · Workflows area · ${tab === 'runs' ? 'runs' : 'saved workflows'}`}
    >
      <ProjectPage>
        <div
          className="flex flex-col gap-4 pb-12 min-w-0 w-full max-w-4xl"
          data-testid="workflows-home"
        >
          <div className="flex items-start gap-3">
            <div className="flex-1 min-w-0">
              <h1 className="sam-type-page-title m-0">Workflows</h1>
              <p className="m-0 mt-1 sam-type-secondary text-fg-muted">
                Agent work in steps you can follow. Save the steps you repeat.
              </p>
            </div>
            <Button size="sm" onClick={() => setPicker(true)} className="shrink-0">
              <Play size={14} /> {isMobile ? 'Start' : 'Start a workflow'}
            </Button>
          </div>

          <div role="tablist" className="flex items-center gap-1 border-b border-border-default">
            {(
              [
                ['runs', 'Runs', RUNS.length, p('b/workflows')],
                ['saved', 'Saved', saved.length, p('b/workflows/saved')],
              ] as const
            ).map(([key, label, count, to]) => (
              <Link
                key={key}
                to={to}
                role="tab"
                aria-selected={tab === key}
                className={`inline-flex items-center gap-1.5 px-3 py-2 text-sm no-underline border-b-2 ${tab === key ? 'border-b-accent text-accent font-semibold' : 'border-b-transparent text-fg-muted hover:text-fg-primary'}`}
                style={{ borderBottomStyle: 'solid' }}
              >
                {label}
                <span className="rounded-full px-1.5 text-[10px] bg-[var(--sam-color-bg-inset)] text-fg-muted">
                  {count}
                </span>
              </Link>
            ))}
          </div>

          {tab === 'runs' ? (
            <>
              <Section title="Needs you" count={needsYou.length} tone="var(--sam-color-warning-fg)">
                {needsYou.map(({ run }) => (
                  <RunCard key={run.id} run={run} />
                ))}
              </Section>
              <Section title="Running" count={active.length}>
                {active.map(({ run }) => (
                  <RunCard key={run.id} run={run} />
                ))}
              </Section>
              <Section title="Finished" count={finished.length}>
                {finished.map(({ run }) => (
                  <RunCard key={run.id} run={run} />
                ))}
              </Section>
            </>
          ) : saved.length === 0 ? (
            <EmptyState
              icon={<Bookmark size={28} />}
              heading="No saved workflows yet"
              description="When a one-off run works well, use “Save as workflow” on it. Or ask an agent in chat to set one up for something you do every week."
              action={{ label: 'Start a one-off in chat', onClick: () => undefined }}
            />
          ) : (
            <>
              <p className="m-0 text-xs text-fg-muted leading-relaxed">
                A saved workflow is a reusable list of steps. Starting one creates a run you can
                follow; editing it later never changes runs already going.
              </p>
              <div className={`grid gap-3 ${isMobile ? 'grid-cols-1' : 'grid-cols-2'}`}>
                {saved.map((wf) => (
                  <SavedCard key={wf.id} wf={wf} />
                ))}
              </div>
            </>
          )}
        </div>
      </ProjectPage>
      <StartPicker isOpen={picker} onClose={() => setPicker(false)} />
    </ProtoShell>
  );
}
