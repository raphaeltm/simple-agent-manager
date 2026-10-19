/**
 * PROTOTYPE ONLY — Option A, "Runs live in Chat" (Tasks-integrated).
 * No new navigation. A run is a row in the chat list and opens in the chat
 * pane; its step chats are tucked inside it. Saved workflows start from the
 * composer and are kept under Ideas ("Plans"), where draft tasks already live.
 */
import { Button } from '@simple-agent-manager/ui';
import { Bookmark, Lightbulb, ListTodo, MessageSquare, Play, Search, Workflow } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router';

import { useIsMobile } from '../../hooks/useIsMobile';
import { ChatLayout, SessionRows } from './chat-layout';
import { CSV_RUN } from './mock-runs-code-change';
import { RESEARCH_RUN } from './mock-runs-research';
import { SAVED_WORKFLOWS } from './mock-workflows';
import { NON_STEP_SESSIONS } from './mock-world';
import { countSteps, frameAt, progressSentence, type RunDef } from './model';
import { RunChecklist } from './run-checklist';
import { p, ProjectPage, ProtoShell } from './shell';
import { RUN_META, RunStatusPill, StepProgressBar } from './status-ui';
import { ShapeStrip } from './workflow-cards';

/** Mirrors SessionItem's row geometry so a run reads as a peer of a chat. */
export function RunListRow({
  run,
  selected,
  onSelect,
}: {
  run: RunDef;
  selected: boolean;
  onSelect: () => void;
}) {
  const frame = frameAt(run, null);
  const meta = RUN_META[frame.status];
  const Icon = meta.icon;
  const counts = countSteps(frame, run.steps);
  return (
    <div
      style={{
        background: selected ? 'var(--sam-color-bg-inset, #0d1816)' : 'transparent',
        borderBottom: '1px solid var(--sam-color-border-default, #29423b)',
      }}
    >
      <button
        type="button"
        onClick={onSelect}
        className={`block w-full text-left px-3 py-1.5 bg-transparent border-none cursor-pointer ${selected ? 'bg-[rgba(22,163,74,0.08)]' : ''}`}
        style={{
          borderLeft: selected
            ? '3px solid var(--sam-color-accent-primary)'
            : '3px solid transparent',
        }}
      >
        <span className="flex items-center gap-1.5 mb-0.5">
          <Icon
            size={14}
            style={{ color: meta.color }}
            className={meta.spin ? 'motion-safe:animate-spin' : ''}
          />
          <span
            className={`overflow-hidden text-ellipsis whitespace-nowrap flex-1 text-fg-primary ${selected ? 'font-semibold' : 'font-medium'}`}
          >
            {run.title}
          </span>
        </span>
        <span
          className="flex items-center gap-1.5 text-fg-muted"
          style={{ fontSize: 10, paddingLeft: 20 }}
        >
          <Workflow size={10} />
          <span>Run</span>
          <span>·</span>
          <span
            className="truncate"
            style={{ color: counts.needsYou ? 'var(--sam-color-warning-fg)' : undefined }}
          >
            {counts.needsYou ? 'Waiting for you' : progressSentence(counts)}
          </span>
        </span>
        <span className="block mt-1" style={{ paddingLeft: 20 }}>
          <StepProgressBar steps={run.steps} frame={frame} height={4} />
        </span>
      </button>
    </div>
  );
}

function Filters({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="grid grid-cols-3 gap-1 rounded-md border border-border-default bg-surface/40 p-0.5">
      {['All', 'Chats', 'Runs'].map((v) => (
        <button
          key={v}
          type="button"
          aria-pressed={value === v}
          onClick={() => onChange(v)}
          className={`rounded-sm px-2 py-1 text-[11px] font-medium border-none cursor-pointer ${value === v ? 'bg-accent/15 text-accent' : 'bg-transparent text-fg-muted'}`}
        >
          {v}
        </button>
      ))}
    </div>
  );
}

export function OptionAChat() {
  const [filter, setFilter] = useState('All');
  const [selected, setSelected] = useState<string>(CSV_RUN.id);
  const navigate = useNavigate();
  const run = selected === RESEARCH_RUN.id ? RESEARCH_RUN : CSV_RUN;
  const frame = frameAt(run, null);
  const counts = countSteps(frame, run.steps);
  const runRows = [CSV_RUN, RESEARCH_RUN].map((r) => (
    <RunListRow
      key={r.id}
      run={r}
      selected={selected === r.id}
      onSelect={() => setSelected(r.id)}
    />
  ));
  const rows = (
    <SessionRows
      sessions={filter === 'Runs' ? [] : NON_STEP_SESSIONS}
      selectedId={null}
      onSelect={() => navigate(p('b/chat'))}
      before={filter === 'Chats' ? null : runRows}
    />
  );

  return (
    <ChatLayout
      option="A"
      label="Option A · runs live in the chat list"
      rows={rows}
      filters={<Filters value={filter} onChange={setFilter} />}
    >
      <div className="flex-1 min-h-0 flex flex-col">
        <div className="shrink-0 px-4 py-2.5 glass-chrome border-x-0 border-t-0">
          <div className="text-sm font-semibold text-fg-primary truncate">{run.title}</div>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-fg-muted">
            <RunStatusPill status={frame.status} />
            <span>{progressSentence(counts)}</span>
            <span className="inline-flex items-center gap-1">
              <MessageSquare size={11} />{' '}
              {run.steps.filter((s) => frame.steps[s.key]?.started).length} step chats inside
            </span>
          </div>
          <StepProgressBar steps={run.steps} frame={frame} className="mt-2" />
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto px-4 py-4" data-scroll-target>
          <RunChecklist
            run={run}
            frame={frame}
            selectedKey={null}
            onSelect={() => navigate(p('b/step-chat'))}
            sideBySide={false}
          />
        </div>
        <div className="relative shrink-0 glass-chrome border-x-0 border-b-0 px-4 py-3 text-xs text-fg-muted">
          The run has no agent to message. Open a step to talk to its agent, or use the run
          controls.
          <div className="mt-2 flex gap-2">
            <Button size="sm" variant="secondary">
              Pause
            </Button>
            <Button size="sm" variant="ghost">
              Cancel run
            </Button>
          </div>
        </div>
      </div>
    </ChatLayout>
  );
}

export function OptionANewChat() {
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(true);
  const chips = ['Claude Code — Opus 5', 'Codex 5.5 High', 'Brainstormer'];
  return (
    <ChatLayout
      option="A"
      label="Option A · start a saved workflow from the composer"
      rows={
        <SessionRows sessions={NON_STEP_SESSIONS} selectedId={null} onSelect={() => undefined} />
      }
    >
      <div className="flex-1 flex flex-col min-h-0">
        <div
          className={`flex-1 min-h-0 overflow-y-auto flex flex-col items-center gap-3 ${isMobile ? 'p-4' : 'p-8 justify-center'}`}
        >
          <span className="text-base font-semibold text-fg-primary">
            What do you want to build?
          </span>
          <span className="sam-type-secondary text-fg-muted text-center max-w-[400px]">
            Pick an agent profile — or a saved workflow — below.
          </span>
        </div>
        <div className="relative shrink-0 glass-chrome border-x-0 border-b-0 px-4 py-3">
          {open && (
            <div
              className="mb-2 rounded-lg glass-surface border border-border-default p-2 max-w-md"
              role="listbox"
              aria-label="Saved workflows"
            >
              <div className="px-2 pb-1.5 text-[10px] font-semibold uppercase tracking-wider text-fg-muted">
                Saved workflows
              </div>
              {SAVED_WORKFLOWS.slice(0, 3).map((wf) => (
                <div
                  key={wf.id}
                  className="flex items-center gap-2 rounded-md px-2 py-2 hover:bg-surface-hover"
                >
                  <Bookmark size={13} className="text-fg-muted shrink-0" />
                  <span className="text-sm text-fg-primary truncate flex-1">{wf.name}</span>
                  <ShapeStrip steps={wf.steps} size={8} />
                </div>
              ))}
              <div className="px-2 pt-1.5 text-[11px] text-fg-muted">
                Manage them in Ideas › Plans
              </div>
            </div>
          )}
          <div className="flex flex-wrap gap-1.5 mb-2">
            {chips.map((c, i) => (
              <span
                key={c}
                className={`min-h-8 inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium ${i === 0 && !open ? 'border-accent bg-accent/10 text-accent' : 'border-border-default text-fg-muted'}`}
              >
                {c}
              </span>
            ))}
            <button
              type="button"
              onClick={() => setOpen((o) => !o)}
              className={`min-h-8 inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium cursor-pointer ${open ? 'border-accent bg-accent/10 text-accent' : 'border-dashed border-border-default text-fg-muted bg-transparent'}`}
            >
              <Play size={11} /> Workflow
            </button>
          </div>
          <textarea
            rows={1}
            placeholder={
              open ? 'Pick a workflow, then fill in its blanks...' : 'Describe the task...'
            }
            className="w-full p-2 px-3 bg-[var(--sam-form-bg)] border border-[rgba(34,197,94,0.12)] rounded-md text-base min-h-[38px] text-fg-primary resize-none"
          />
        </div>
      </div>
    </ChatLayout>
  );
}

export function OptionAPlans() {
  const isMobile = useIsMobile();
  return (
    <ProtoShell option="A" active="ideas" label="Option A · saved workflows kept under Ideas">
      <ProjectPage>
        <div className={`flex flex-col gap-3 ${isMobile ? '' : 'px-2'}`}>
          <h1 className="m-0 text-xl font-semibold text-fg-primary">Ideas</h1>
          <p className="m-0 text-sm text-fg-muted">6 ideas being refined · 5 saved workflows</p>
          <div role="tablist" className="flex gap-1 border-b border-border-default">
            {[
              ['Ideas', false, Lightbulb],
              ['Plans (saved workflows)', true, Bookmark],
            ].map(([label, active, Icon]) => {
              const I = Icon as typeof Lightbulb;
              return (
                <span
                  key={label as string}
                  className={`inline-flex items-center gap-1.5 px-3 py-2 text-sm border-b-2 ${active ? 'border-b-accent text-accent font-semibold' : 'border-b-transparent text-fg-muted'}`}
                  style={{ borderBottomStyle: 'solid' }}
                >
                  <I size={14} /> {label as string}
                </span>
              );
            })}
          </div>
          <div className="relative flex items-center">
            <Search size={14} className="absolute left-3 text-fg-muted" />
            <input
              placeholder="Search plans..."
              className="w-full min-h-10 pl-9 pr-3 rounded-md bg-[var(--sam-form-bg)] border border-[var(--sam-form-border)] text-sm text-fg-primary"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            {SAVED_WORKFLOWS.map((wf) => (
              <div
                key={wf.id}
                className="rounded-lg border border-[var(--sam-form-border)] bg-[var(--sam-glass-nested-bg)] px-3 py-2.5 min-h-[56px] flex items-center gap-3"
              >
                <ListTodo size={16} className="text-fg-muted shrink-0" />
                <span className="flex-1 min-w-0">
                  <span className="block text-sm font-medium text-fg-primary line-clamp-1 break-words">
                    {wf.name}
                  </span>
                  <span className="block text-xs text-fg-muted line-clamp-1">
                    {wf.steps.length} steps · used {wf.usedCount}×{' '}
                    {wf.schedule ? `· ${wf.schedule.label}` : ''}
                  </span>
                </span>
                {!isMobile && <ShapeStrip steps={wf.steps} size={9} />}
                <Button size="sm" variant="secondary">
                  <Play size={13} /> Run
                </Button>
              </div>
            ))}
          </div>
          <p className="m-0 text-xs text-fg-muted">
            Runs of these plans show up in Chat like any other conversation, with their step chats
            inside.
          </p>
        </div>
      </ProjectPage>
    </ProtoShell>
  );
}
