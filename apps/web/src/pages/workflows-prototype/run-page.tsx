/**
 * PROTOTYPE ONLY — Option B run page: /projects/:id/workflows/runs/:runId.
 * Checklist by default (mobile-first), graph on desktop, activity log, and a
 * step panel (side column on desktop, bottom sheet on phones).
 */
import { Breadcrumb, Button, DropdownMenu } from '@simple-agent-manager/ui';
import {
  ArrowUpRight,
  Bookmark,
  CircleStop,
  History,
  ListChecks,
  Network,
  Pause,
  Play,
} from 'lucide-react';
import { type ReactNode, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';

import { useIsMobile } from '../../hooks/useIsMobile';
import { getRun, getSaved } from './mock-workflows';
import { countSteps, progressSentence, type RunDef, type RunFrame, type StepStatus } from './model';
import { SimulationBar, useParam, useRunFrame } from './proto-controls';
import { RunChecklist } from './run-checklist';
import { RunGraph } from './run-graph';
import { ActivityLog, CancelDialog, RunCallout, SaveAsDialog } from './run-parts';
import { p, ProjectPage, ProtoShell } from './shell';
import {
  EvidenceChip,
  OriginChip,
  RunStatusPill,
  StarterLabel,
  StepIcon,
  StepProgressBar,
} from './status-ui';
import { StepPanel } from './step-panel';

const SCRIPTED: Record<string, Partial<Record<'approve' | 'reject' | 'retry' | 'skip', string>>> = {
  'run-csv': { approve: 'csv-6', reject: 'csv-rejected' },
  'run-flags': { retry: 'flags-4', skip: 'flags-skipped' },
};

/** Generic owner actions that don't need a scripted frame. */
function overlay(frame: RunFrame, mode: 'paused' | 'cancelled' | null): RunFrame {
  if (!mode) return frame;
  if (mode === 'paused') return { ...frame, status: 'paused' };
  const live: StepStatus[] = ['running', 'starting', 'up_next', 'waiting', 'needs_you', 'blocked'];
  const steps = Object.fromEntries(
    Object.entries(frame.steps).map(([k, s]) => [
      k,
      live.includes(s.status)
        ? {
            ...s,
            status: 'cancelled' as const,
            reason:
              s.status === 'running' || s.status === 'starting'
                ? 'Stopped by you · work pushed first'
                : 'Not started',
          }
        : s,
    ])
  );
  return { ...frame, status: 'cancelled', steps };
}

function Tab({
  active,
  onClick,
  icon,
  children,
}: {
  active: boolean;
  onClick: () => void;
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 px-3 py-2 text-sm bg-transparent border-none border-b-2 cursor-pointer ${active ? 'border-b-accent text-accent font-semibold' : 'border-b-transparent text-fg-muted hover:text-fg-primary'}`}
      style={{ borderBottomStyle: 'solid' }}
    >
      {icon}
      {children}
    </button>
  );
}

function AboutRun({ run, frame }: { run: RunDef; frame: RunFrame }) {
  const notStarted = ['waiting', 'up_next', 'blocked'];
  const chats = run.steps.filter(
    (s) => s.kind === 'agent' && !notStarted.includes(frame.steps[s.key]?.status ?? 'waiting')
  );
  const outputs = [
    ...new Map(
      run.steps
        .flatMap((s) => frame.steps[s.key]?.evidence ?? [])
        .filter((e) => e.kind === 'pr' || e.kind === 'file' || e.kind === 'deploy')
        .map((e) => [e.label, e] as const)
    ).values(),
  ];
  const saved = run.origin.kind === 'saved' ? getSaved(run.origin.workflowId) : null;
  return (
    <div className="flex flex-col gap-4">
      {run.inputs && (
        <section className="flex flex-col gap-2">
          <h3 className="m-0 text-[10px] font-semibold uppercase tracking-wider text-fg-muted">
            What you asked for
          </h3>
          {run.inputs.map((i) => (
            <div
              key={i.label}
              className="rounded-md border border-border-default bg-inset px-2.5 py-2"
            >
              <div className="text-[11px] text-fg-muted">{i.label}</div>
              <div className="text-sm text-fg-primary leading-relaxed break-words">{i.value}</div>
            </div>
          ))}
        </section>
      )}
      <section className="flex flex-col gap-1.5">
        <h3 className="m-0 text-[10px] font-semibold uppercase tracking-wider text-fg-muted">
          Agent chats ({chats.length})
        </h3>
        {chats.length === 0 && (
          <p className="m-0 text-xs text-fg-muted">
            Each agent step gets its own chat when it starts.
          </p>
        )}
        <ul className="list-none m-0 p-0 flex flex-col">
          {chats.map((s) => (
            <li key={s.key}>
              <Link
                to={p('b/step-chat')}
                className="flex items-center gap-2 px-1 py-1.5 rounded-md no-underline text-sm text-fg-primary hover:bg-surface-hover"
              >
                <StepIcon status={frame.steps[s.key]?.status ?? 'waiting'} size={14} />
                <span className="truncate flex-1">{s.title}</span>
                <ArrowUpRight size={13} className="text-fg-muted shrink-0" />
              </Link>
            </li>
          ))}
        </ul>
      </section>
      {outputs.length > 0 && (
        <section className="flex flex-col gap-1.5">
          <h3 className="m-0 text-[10px] font-semibold uppercase tracking-wider text-fg-muted">
            Outputs
          </h3>
          <div className="flex flex-wrap gap-1">
            {outputs.map((e) => (
              <EvidenceChip key={e.label} e={e} />
            ))}
          </div>
        </section>
      )}
      <section className="flex flex-col gap-1 text-xs text-fg-muted leading-relaxed">
        <h3 className="m-0 text-[10px] font-semibold uppercase tracking-wider text-fg-muted">
          How it runs
        </h3>
        <span>
          Up to {run.maxParallel} agents at once. Each step is an ordinary task in your name, on
          your credentials.
        </span>
        {saved ? (
          <span>
            Uses a frozen copy of{' '}
            <Link to={p(`b/workflows/saved/${saved.id}`)} className="text-accent">
              {saved.name} v{run.origin.kind === 'saved' ? run.origin.version : ''}
            </Link>
            . Editing the workflow won’t change this run.
          </span>
        ) : (
          <span>One-off: these steps aren’t saved anywhere else yet.</span>
        )}
      </section>
    </div>
  );
}

export function RunPage() {
  const { runId } = useParams();
  const run = getRun(runId);
  const isMobile = useIsMobile();
  const navigate = useNavigate();
  const { frame: scripted, goTo } = useRunFrame(run);
  const [stepKey, setStepKey] = useParam('step');
  const [view, setView] = useParam('view');
  const [dialog, setDialog] = useParam('dialog');
  const [mode, setMode] = useState<'paused' | 'cancelled' | null>(null);
  const frame = useMemo(() => overlay(scripted, mode), [scripted, mode]);
  const counts = countSteps(frame, run.steps);
  const saved = run.origin.kind === 'saved' ? getSaved(run.origin.workflowId) : null;
  const script = SCRIPTED[run.id] ?? {};
  const approvalKey = run.steps.find(
    (s) => s.kind === 'approval' && frame.steps[s.key]?.status !== 'waiting'
  )?.key;
  const failedKey = run.steps.find((s) => frame.steps[s.key]?.status === 'failed')?.key;
  const activeView = isMobile && view === 'graph' ? 'steps' : (view ?? 'steps');
  const live = !['done', 'cancelled', 'draft'].includes(frame.status);

  const act = (kind: 'approve' | 'reject' | 'retry' | 'skip') => {
    const target = script[kind];
    if (target) goTo(target);
    setStepKey(null);
  };

  const crumbs = [
    { label: 'Workflows', path: p('b/workflows') },
    saved
      ? { label: saved.name, path: p(`b/workflows/saved/${saved.id}`) }
      : { label: 'One-off runs', path: p('b/workflows?only=one-off') },
    { label: run.origin.kind === 'saved' ? `Run #${run.origin.runNumber}` : 'This run' },
  ];

  const menu = [
    ...(run.origin.kind === 'one_off'
      ? [
          {
            id: 'save',
            label: 'Save as workflow',
            icon: <Bookmark size={14} />,
            onClick: () => setDialog('save'),
          },
        ]
      : [
          {
            id: 'saved',
            label: 'Open saved workflow',
            onClick: () => saved && navigate(p(`b/workflows/saved/${saved.id}`)),
          },
        ]),
    { id: 'copy', label: 'Copy link', onClick: () => undefined },
    ...(live
      ? [
          {
            id: 'cancel',
            label: 'Cancel run',
            variant: 'danger' as const,
            onClick: () => setDialog('cancel'),
          },
        ]
      : []),
  ];

  const panel =
    stepKey !== null ? (
      <StepPanel
        run={run}
        frame={frame}
        stepKey={stepKey}
        onClose={() => setStepKey(null)}
        onApprove={() => act('approve')}
        onReject={() => act('reject')}
        onRetry={() => act('retry')}
        onSkip={() => act('skip')}
      />
    ) : null;

  return (
    <ProtoShell
      option="B"
      active="workflows"
      label="Option B · Workflows area · run page"
      stripExtra={<SimulationBar run={run} />}
    >
      <ProjectPage>
        <div className="pb-12 min-w-0" data-testid="run-page">
          <Breadcrumb segments={crumbs} />
          <div className="mt-3 flex flex-col sm:flex-row sm:items-start gap-3">
            <div className="flex-1 min-w-0">
              <h1 className="sam-type-page-title m-0 break-words line-clamp-3">{run.title}</h1>
              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs">
                <RunStatusPill status={frame.status} />
                <OriginChip run={run} />
                {saved && run.origin.kind === 'saved' && (
                  <Link
                    to={p(`b/workflows/saved/${saved.id}`)}
                    className="text-fg-muted hover:text-fg-primary truncate max-w-[18rem]"
                  >
                    of “{saved.name}” v{run.origin.version}
                  </Link>
                )}
                <StarterLabel run={run} />
                {(frame.status === 'done' || frame.status === 'cancelled') && (
                  <span className="text-fg-muted tabular-nums">took {frame.elapsed}</span>
                )}
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {run.origin.kind === 'one_off' && frame.status === 'done' && (
                <Button size="sm" onClick={() => setDialog('save')}>
                  <Bookmark size={14} /> Save as workflow
                </Button>
              )}
              {live && frame.status !== 'paused' && (
                <Button size="sm" variant="secondary" onClick={() => setMode('paused')}>
                  <Pause size={14} /> Pause
                </Button>
              )}
              {frame.status === 'paused' && (
                <Button size="sm" variant="secondary" onClick={() => setMode(null)}>
                  <Play size={14} /> Resume
                </Button>
              )}
              {live && !isMobile && (
                <Button size="sm" variant="ghost" onClick={() => setDialog('cancel')}>
                  <CircleStop size={14} /> Cancel run
                </Button>
              )}
              <DropdownMenu items={menu} />
            </div>
          </div>

          <div className="mt-4">
            <StepProgressBar steps={run.steps} frame={frame} height={8} />
            <div className="mt-1.5 text-xs text-fg-muted">
              {progressSentence(counts)} · up to {run.maxParallel} at once
            </div>
          </div>

          <div className="mt-4">
            <RunCallout
              run={run}
              frame={frame}
              onDecide={() => approvalKey && setStepKey(approvalKey)}
              onRetry={() => (failedKey ? setStepKey(failedKey) : act('retry'))}
              onSkip={() => act('skip')}
              onResume={() => setMode(null)}
              onSave={() => setDialog('save')}
            />
          </div>

          <div
            role="tablist"
            className="mt-4 flex items-center gap-1 border-b border-border-default"
          >
            <Tab
              active={activeView === 'steps'}
              onClick={() => setView(null)}
              icon={<ListChecks size={15} />}
            >
              Steps
            </Tab>
            {!isMobile && (
              <Tab
                active={activeView === 'graph'}
                onClick={() => setView('graph')}
                icon={<Network size={15} />}
              >
                Graph
              </Tab>
            )}
            <Tab
              active={activeView === 'activity'}
              onClick={() => setView('activity')}
              icon={<History size={15} />}
            >
              Activity
            </Tab>
          </div>

          <div
            className={`mt-4 ${isMobile ? '' : 'grid grid-cols-[minmax(0,1fr)_340px] gap-6 items-start'}`}
          >
            <div className="min-w-0">
              {activeView === 'steps' && (
                <RunChecklist
                  run={run}
                  frame={frame}
                  selectedKey={stepKey}
                  onSelect={(k) => setStepKey(k === stepKey ? null : k)}
                  onDecide={() => approvalKey && setStepKey(approvalKey)}
                  onRetry={() => failedKey && setStepKey(failedKey)}
                  onSkip={() => act('skip')}
                  sideBySide={!isMobile}
                />
              )}
              {activeView === 'graph' && (
                <RunGraph
                  run={run}
                  frame={frame}
                  selectedKey={stepKey}
                  onSelect={(k) => setStepKey(k)}
                />
              )}
              {activeView === 'activity' && <ActivityLog entries={frame.activity} />}
            </div>
            {!isMobile && (
              <aside className="sticky top-4 max-h-[calc(100vh-7rem)] overflow-y-auto rounded-lg border border-border-default p-4 bg-[color-mix(in_srgb,var(--sam-color-bg-surface)_75%,transparent)] min-w-0">
                {panel ?? <AboutRun run={run} frame={frame} />}
              </aside>
            )}
          </div>
          {isMobile && activeView === 'steps' && (
            <div className="mt-6 rounded-lg border border-border-default p-3">
              <AboutRun run={run} frame={frame} />
            </div>
          )}
        </div>
      </ProjectPage>

      {isMobile && panel && (
        <div
          className="fixed inset-0 z-50"
          role="dialog"
          aria-modal="true"
          aria-label="Step details"
        >
          <button
            type="button"
            aria-label="Close"
            className="absolute inset-0 glass-backdrop-dim border-none"
            onClick={() => setStepKey(null)}
          />
          <div className="absolute bottom-0 left-0 right-0 glass-modal glass-panel-container rounded-t-2xl max-h-[88dvh] overflow-y-auto px-4 pt-3 pb-8">
            <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-[var(--sam-color-border-default)]" />
            {panel}
          </div>
        </div>
      )}

      <CancelDialog
        isOpen={dialog === 'cancel'}
        onClose={() => setDialog(null)}
        onConfirm={() => {
          setMode('cancelled');
          setDialog(null);
        }}
        runningCount={counts.running}
      />
      <SaveAsDialog
        isOpen={dialog === 'save'}
        onClose={() => setDialog(null)}
        onSave={() => navigate(p('b/workflows/saved/tech-compare?justSaved=1'))}
        run={run}
      />
    </ProtoShell>
  );
}
