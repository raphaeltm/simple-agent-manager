/**
 * PROTOTYPE direction A, "Right now": what needs you, then every machine as a box that holds
 * the workspaces and agents running on it. Connections are shown by containment instead of
 * lines. Never merge to main.
 */
import { Button, buttonClassName, Chip, Pane, PaneSeparator } from '@simple-agent-manager/ui';
import { ChevronRight, GitBranch, Sparkles } from 'lucide-react';
import { useState } from 'react';

import type { MockAttention, MockMachine, MockScene } from './mock-data';
import {
  AttentionIcon,
  formatCost,
  lookup,
  MachineIcon,
  MachineStateChip,
  Meter,
  PrChip,
  ProjectMark,
  WorkStateIcon,
} from './parts';

type Highlight = { machineId?: string; workspaceId?: string; workId?: string } | null;

function Summary({ scene }: { scene: MockScene }) {
  const working = scene.work.filter((w) => w.state === 'working').length;
  const paid = scene.machines.filter((m) => !m.instant);
  const perHour = paid.reduce((sum, m) => sum + m.costPerHour, 0);
  const items = [
    { value: String(working), label: working === 1 ? 'agent working' : 'agents working' },
    { value: String(scene.attention.length), label: 'need you', attention: scene.attention.length > 0 },
    { value: String(paid.length), label: paid.length === 1 ? 'machine' : 'machines' },
    { value: `$${perHour.toFixed(2)}`, label: 'per hour now' },
  ];
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {items.map((item) => (
        <div key={item.label} className="sam-well rounded-[var(--sam-radius-control)] px-3 py-2.5">
          <div
            className="font-mono text-[22px] font-semibold leading-none"
            style={{ color: item.attention ? 'var(--sam-status-warning-fg)' : 'var(--sam-color-fg-primary)' }}
          >
            {item.value}
          </div>
          <div className="mt-1 text-[12px] text-fg-muted">{item.label}</div>
        </div>
      ))}
    </div>
  );
}

function AttentionList({
  scene,
  selected,
  onSelect,
}: {
  scene: MockScene;
  selected: string | null;
  onSelect: (item: MockAttention) => void;
}) {
  const { project, machine } = lookup(scene);
  return (
    <Pane className="flex flex-col">
      <div className="flex items-center gap-2 px-4 pb-2 pt-3.5">
        <h2 className="m-0 flex-1 text-[15px] font-semibold text-fg-primary">Needs you</h2>
        {scene.attention.length > 0 && (
          <span className="grid h-5 min-w-5 place-items-center rounded-full bg-[var(--sam-status-warning-fg)] px-1.5 font-mono text-[11px] font-semibold text-[var(--sam-attention-ink)]">
            {scene.attention.length}
          </span>
        )}
      </div>
      {scene.attention.length === 0 ? (
        <p className="m-0 px-4 pb-4 text-[13px] text-fg-muted">Nothing is waiting on you. Your agents will ask here when they need something.</p>
      ) : (
        <ul className="m-0 list-none p-0 pb-2">
          {scene.attention.map((item, i) => {
            const p = project(item.projectId);
            const m = machine(item.machineId);
            const isSelected = selected === item.id;
            return (
              <li key={item.id}>
                {i > 0 && <PaneSeparator className="mx-4" />}
                <button
                  type="button"
                  onClick={() => onSelect(item)}
                  className={`flex w-full cursor-pointer gap-3 border-0 px-4 py-3 text-left ${
                    isSelected ? 'bg-[var(--sam-status-warning-bg)]' : 'bg-transparent hover:bg-[var(--sam-chip-bg)]'
                  }`}
                >
                  <AttentionIcon kind={item.kind} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline gap-2">
                      <span className="line-clamp-2 min-w-0 flex-1 break-words text-[14px] font-medium text-fg-primary">{item.title}</span>
                      <span className="shrink-0 font-mono text-[11px] text-fg-muted">{item.age}</span>
                    </span>
                    <span className="mt-0.5 line-clamp-2 text-[13px] text-fg-muted">{item.detail}</span>
                    <span className="mt-1.5 flex min-w-0 items-center gap-1 text-[12px] text-fg-muted">
                      {p && <span className="truncate">{p.name}</span>}
                      {m && (
                        <>
                          <ChevronRight size={12} className="shrink-0" aria-hidden="true" />
                          <span className="truncate">{m.name}</span>
                        </>
                      )}
                    </span>
                    <span className={`${buttonClassName({ size: 'sm', variant: i === 0 ? 'accent' : 'raised' })} mt-2.5`}>{item.action}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Pane>
  );
}

function MachineCard({ scene, machine, highlight }: { scene: MockScene; machine: MockMachine; highlight: Highlight }) {
  const { project } = lookup(scene);
  const hosted = scene.workspaces.filter((w) => w.machineId === machine.id);
  const lit = highlight?.machineId === machine.id;
  const noteTone = machine.state === 'unhealthy' ? 'danger' : machine.disk >= 80 ? 'warning' : 'muted';
  return (
    <Pane
      className={`flex flex-col transition-shadow ${lit ? 'outline outline-2 outline-offset-2 outline-[var(--sam-status-warning-fg)]' : ''}`}
      aria-label={`Machine ${machine.name}`}
    >
      <div className="flex items-start gap-2.5 px-4 pt-3.5">
        <MachineIcon machine={machine} size={18} />
        <div className="min-w-0 flex-1">
          <div className="truncate font-mono text-[14px] font-semibold text-fg-primary">{machine.name}</div>
          <div className="text-[12px] text-fg-muted">
            {machine.provider} · {machine.location} · {machine.size}
          </div>
        </div>
        <MachineStateChip machine={machine} />
      </div>
      {!machine.instant && machine.state !== 'unhealthy' && (
        <div className="flex gap-3 px-4 pt-3">
          <Meter label="CPU" value={machine.cpu} />
          <Meter label="Memory" value={machine.memory} />
          <Meter label="Disk" value={machine.disk} />
        </div>
      )}
      {machine.note && (
        <p
          className="m-0 px-4 pt-2.5 text-[12.5px]"
          style={{ color: noteTone === 'muted' ? 'var(--sam-color-fg-muted)' : `var(--sam-status-${noteTone}-fg)` }}
        >
          {machine.note}
        </p>
      )}
      <div className="flex-1 px-2.5 pb-2.5 pt-3">
        {hosted.length === 0 ? (
          <div className="sam-well rounded-[var(--sam-radius-control)] px-3 py-3 text-center text-[12.5px] text-fg-muted">No workspaces</div>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
            {hosted.map((ws) => {
              const p = project(ws.projectId);
              const items = scene.work.filter((w) => w.workspaceId === ws.id);
              const wsLit = highlight?.workspaceId === ws.id;
              return (
                <li
                  key={ws.id}
                  className={`sam-well rounded-[var(--sam-radius-control)] px-3 py-2 ${wsLit ? 'ring-2 ring-[var(--sam-status-warning-fg)]' : ''}`}
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <ProjectMark name={p?.name ?? '?'} size={18} />
                    <span className="min-w-0 truncate text-[13px] font-medium text-fg-primary">{p?.name}</span>
                    <span className="flex min-w-0 flex-1 items-center gap-1 text-[11.5px] text-fg-muted">
                      <GitBranch size={11} className="shrink-0" aria-hidden="true" />
                      <span className="truncate font-mono">{ws.branch}</span>
                    </span>
                  </div>
                  {items.map((w) => (
                    <div key={w.id} className="mt-1.5 flex min-w-0 items-start gap-2 pl-[26px]">
                      <WorkStateIcon state={w.state} size={14} />
                      <span className="line-clamp-2 min-w-0 flex-1 break-words text-[12.5px] text-fg-primary">{w.title}</span>
                      {w.pr && <PrChip pr={w.pr} />}
                      <span className="hidden shrink-0 font-mono text-[11px] text-fg-muted sm:inline">{w.agent}</span>
                    </div>
                  ))}
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <div className="flex items-center justify-between border-t border-[var(--sam-hairline)] px-4 py-2 font-mono text-[11px] text-fg-muted">
        <span>{formatCost(machine.costPerHour)}</span>
        <span>up {machine.uptime}</span>
      </div>
    </Pane>
  );
}

function Projects({ scene }: { scene: MockScene }) {
  const [showQuiet, setShowQuiet] = useState(false);
  return (
    <Pane className="flex flex-col">
      <h2 className="m-0 px-4 pb-1 pt-3.5 text-[15px] font-semibold text-fg-primary">Projects today</h2>
      <ul className="m-0 list-none p-0">
        {scene.projects.map((p, i) => {
          const running = scene.work.filter((w) => w.projectId === p.id && (w.state === 'working' || w.state === 'needs-you')).length;
          return (
            <li key={p.id}>
              {i > 0 && <PaneSeparator className="mx-4" />}
              <div className="flex min-w-0 items-center gap-2.5 px-4 py-2.5">
                <ProjectMark name={p.name} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13.5px] font-medium text-fg-primary">{p.name}</div>
                  <div className="truncate text-[12px] text-fg-muted">
                    {p.doneToday} done today · {p.openIdeas} open ideas
                  </div>
                </div>
                {running > 0 ? <Chip tone="success" size="sm" dot>{running} live</Chip> : null}
                <span className="w-9 shrink-0 text-right font-mono text-[11px] text-fg-muted">{p.lastActive}</span>
              </div>
            </li>
          );
        })}
      </ul>
      {scene.quietProjectCount > 0 && (
        <button
          type="button"
          onClick={() => setShowQuiet((v) => !v)}
          className="cursor-pointer border-0 border-t border-solid border-[var(--sam-hairline)] bg-transparent px-4 py-2.5 text-left text-[12.5px] text-fg-muted hover:text-fg-primary"
        >
          {showQuiet ? 'Hide' : 'Show'} {scene.quietProjectCount} quiet projects
        </button>
      )}
    </Pane>
  );
}

export function DirectionA({ scene, isMobile }: { scene: MockScene; isMobile: boolean }) {
  const [selected, setSelected] = useState<MockAttention | null>(null);
  const highlight: Highlight = selected
    ? { machineId: selected.machineId, workspaceId: selected.workspaceId, workId: selected.workId }
    : null;

  const select = (item: MockAttention) => {
    setSelected((cur) => (cur?.id === item.id ? null : item));
    if (item.machineId) {
      document.querySelector(`[aria-label="Machine ${lookup(scene).machine(item.machineId)?.name}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  };

  const header = (
    <Pane variant="slab" as="header" className="px-4 py-3.5 sm:px-5">
      <h1 className="m-0 text-[22px] font-bold text-fg-primary sm:text-[24px]">Your account right now</h1>
      <p className="m-0 mb-3 mt-1 text-[13.5px] text-fg-muted">What your agents are doing, where they run, and what needs you.</p>
      <Summary scene={scene} />
    </Pane>
  );

  const machinesSection =
    scene.machines.length === 0 ? (
      <Pane className="flex flex-col items-center gap-2 px-6 py-10 text-center">
        <Sparkles size={22} className="text-fg-muted" aria-hidden="true" />
        <p className="m-0 text-[15px] font-semibold text-fg-primary">No machines running</p>
        <p className="m-0 max-w-[340px] text-[13px] text-fg-muted">
          When you start a chat or a task, SAM starts a machine for it and it shows up here with everything running on it.
        </p>
        <Button size="sm" variant="accent" className="mt-2">Start a chat</Button>
      </Pane>
    ) : (
      <div className="grid gap-[var(--sam-space-gutter)]" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 330px), 1fr))' }}>
        {scene.machines.map((m) => (
          <MachineCard key={m.id} scene={scene} machine={m} highlight={highlight} />
        ))}
      </div>
    );

  if (isMobile) {
    return (
      <div className="flex flex-col gap-2.5 pb-6">
        {header}
        <AttentionList scene={scene} selected={selected?.id ?? null} onSelect={select} />
        <h2 className="m-0 px-1 pt-2 text-[13px] font-semibold uppercase tracking-wide text-fg-muted">Where it runs</h2>
        {machinesSection}
        <Projects scene={scene} />
      </div>
    );
  }

  return (
    <div className="grid h-full min-h-0 gap-[var(--sam-space-gutter)]" style={{ gridTemplateColumns: 'minmax(0, 1fr) 360px', gridTemplateRows: 'auto minmax(0, 1fr)' }}>
      <div style={{ gridColumn: '1 / -1' }}>{header}</div>
      <div className="-m-2 min-h-0 overflow-y-auto p-2">
        <h2 className="m-0 px-1 pb-2.5 text-[12px] font-semibold uppercase tracking-wide text-fg-muted">Where it runs</h2>
        {machinesSection}
      </div>
      <div className="-m-2 flex min-h-0 flex-col gap-[var(--sam-space-gutter)] overflow-y-auto p-2">
        <AttentionList scene={scene} selected={selected?.id ?? null} onSelect={select} />
        <Projects scene={scene} />
      </div>
    </div>
  );
}
