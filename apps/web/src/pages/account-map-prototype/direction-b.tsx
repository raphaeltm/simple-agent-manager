/**
 * PROTOTYPE direction B, "Connections": the map, made legible. Three ordered columns
 * (projects → chats and tasks → machines) with lines between them. Pick anything and its
 * whole chain lights up while the rest steps back; a path bar spells the chain out in words.
 * Never merge to main.
 */
import { buttonClassName, Pane, SegmentedControl } from '@simple-agent-manager/ui';
import { ArrowRight, GitBranch, Lightbulb } from 'lucide-react';
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';

import type { MockScene, MockWork } from './mock-data';
import {
  formatCost,
  lookup,
  MachineIcon,
  MachineStateChip,
  PrChip,
  ProjectMark,
  WorkStateChip,
  WorkStateIcon,
} from './parts';

type Filter = 'all' | 'attention' | 'live';

const STATE_ORDER: Record<MockWork['state'], number> = { 'needs-you': 0, failed: 1, working: 2, idle: 3, sleeping: 4, done: 5 };

interface Graph {
  projects: MockScene['projects'];
  work: MockWork[];
  machines: MockScene['machines'];
  edges: Array<{ from: string; to: string; tone: 'attention' | 'live' | 'quiet' }>;
}

function buildGraph(scene: MockScene, filter: Filter): Graph {
  const attentionWork = new Set(scene.attention.map((a) => a.workId));
  const projectIndex = new Map(scene.projects.map((p, i) => [p.id, i]));
  const work = scene.work
    .filter((w) =>
      filter === 'all' ? true : filter === 'attention' ? attentionWork.has(w.id) : w.state === 'working' || w.state === 'needs-you'
    )
    .sort((a, b) => ((projectIndex.get(a.projectId) ?? 0) - (projectIndex.get(b.projectId) ?? 0)) || STATE_ORDER[a.state] - STATE_ORDER[b.state]);
  const projects = scene.projects.filter((p) => work.some((w) => w.projectId === p.id) || filter === 'all');
  // Order machines by their first chat so lines cross as little as possible.
  const firstUse = (machineId: string) => {
    const i = work.findIndex((w) => scene.workspaces.find((ws) => ws.id === w.workspaceId)?.machineId === machineId);
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  };
  const machines = scene.machines
    .filter((m) => filter === 'all' || firstUse(m.id) !== Number.MAX_SAFE_INTEGER)
    .sort((a, b) => firstUse(a.id) - firstUse(b.id));
  const edges: Graph['edges'] = [];
  for (const w of work) {
    const tone = attentionWork.has(w.id) ? 'attention' : w.state === 'working' ? 'live' : 'quiet';
    edges.push({ from: w.projectId, to: w.id, tone });
    if (w.workspaceId) edges.push({ from: w.id, to: w.workspaceId, tone });
  }
  return { projects, work, machines, edges };
}

/** Everything upstream and downstream of one node, without wandering sideways. */
function chainOf(scene: MockScene, id: string | null): Set<string> {
  const chain = new Set<string>();
  if (!id) return chain;
  const { workspace } = lookup(scene);
  const addWork = (w: MockWork) => {
    chain.add(w.id).add(w.projectId);
    const ws = workspace(w.workspaceId);
    if (ws) chain.add(ws.id).add(ws.machineId);
  };
  chain.add(id);
  for (const w of scene.work) {
    const ws = workspace(w.workspaceId);
    if (w.id === id || w.projectId === id || ws?.id === id || ws?.machineId === id) addWork(w);
  }
  return chain;
}

function PathBar({ scene, selectedId }: { scene: MockScene; selectedId: string | null }) {
  const { project, workspace, machine, machineForWork } = lookup(scene);
  const w = scene.work.find((x) => x.id === selectedId);
  if (!w) {
    const m = machine(selectedId);
    const p = project(selectedId);
    const text = m
      ? `${m.name} runs ${scene.workspaces.filter((x) => x.machineId === m.id).length} workspaces · ${m.provider} ${m.location} · ${formatCost(m.costPerHour)}`
      : p
        ? `${p.name}: ${scene.work.filter((x) => x.projectId === p.id).length} chats and tasks shown`
        : 'Pick a chat, project or machine to see how it connects.';
    return <p className="m-0 truncate text-[13px] text-fg-muted">{text}</p>;
  }
  const ws = workspace(w.workspaceId);
  const m = machineForWork(w);
  const steps: Array<{ label: string; value: string; mono?: boolean }> = [
    { label: 'Project', value: project(w.projectId)?.name ?? '' },
    ...(w.idea ? [{ label: 'Idea', value: w.idea }] : []),
    { label: w.kind === 'task' ? 'Task' : 'Chat', value: `${w.title} · ${w.agent}` },
    ...(ws ? [{ label: 'Workspace', value: ws.branch, mono: true }] : [{ label: 'Workspace', value: 'none (finished or asleep)' }]),
    ...(m ? [{ label: 'Machine', value: m.instant ? 'Instant container' : `${m.name} · ${m.provider} ${m.location}`, mono: !m.instant }] : []),
    ...(w.pr ? [{ label: 'Pull request', value: `#${w.pr.number} ${w.pr.state}` }] : []),
  ];
  return (
    <ol className="m-0 flex min-w-0 list-none flex-wrap items-center gap-1.5 p-0">
      {steps.map((s, i) => (
        <li key={s.label} className="flex min-w-0 shrink items-center gap-1.5">
          {i > 0 && <ArrowRight size={13} className="shrink-0 text-fg-muted" aria-hidden="true" />}
          <span className="sam-well min-w-0 max-w-[320px] rounded-[var(--sam-radius-control)] px-2.5 py-1">
            <span className="block text-[10px] uppercase tracking-wide text-fg-muted">{s.label}</span>
            <span className={`block truncate text-[12.5px] text-fg-primary ${s.mono ? 'font-mono' : ''}`}>{s.value}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}

function WorkRow({ w, dim, selected, onSelect }: { w: MockWork; dim: boolean; selected: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      data-node={w.id}
      onClick={onSelect}
      className={`flex w-full min-w-0 cursor-pointer flex-col gap-1 rounded-[var(--sam-radius-control)] border px-3 py-2 text-left transition-opacity ${
        selected
          ? 'sam-raised border-[var(--sam-success-edge)]'
          : w.state === 'needs-you'
            ? 'border-[var(--sam-warning-edge)] bg-[var(--sam-chip-bg)]'
            : 'border-[var(--sam-chip-edge)] bg-[var(--sam-chip-bg)]'
      } ${dim ? 'opacity-40' : ''}`}
    >
      <span className="flex min-w-0 items-start gap-2">
        <WorkStateIcon state={w.state} size={14} />
        <span className="line-clamp-2 min-w-0 flex-1 break-words text-[13px] font-medium text-fg-primary">{w.title}</span>
        {w.pr && <PrChip pr={w.pr} />}
      </span>
      <span className="flex min-w-0 items-center gap-2 pl-[22px] text-[11.5px] text-fg-muted">
        <span className="shrink-0">{w.agent}</span>
        <span className="shrink-0 font-mono">{w.since}</span>
        {w.idea && (
          <span className="flex min-w-0 items-center gap-1">
            <Lightbulb size={11} className="shrink-0" aria-hidden="true" />
            <span className="truncate">{w.idea}</span>
          </span>
        )}
      </span>
    </button>
  );
}

function DesktopColumns({ scene, graph, chain, selectedId, select }: {
  scene: MockScene;
  graph: Graph;
  chain: Set<string>;
  selectedId: string | null;
  select: (id: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [paths, setPaths] = useState<Array<{ d: string; key: string; tone: string; lit: boolean }>>([]);
  const { project } = lookup(scene);

  const measure = useCallback(() => {
    const root = ref.current;
    if (!root) return;
    const box = root.getBoundingClientRect();
    const anchor = (id: string, side: 'left' | 'right') => {
      const el = root.querySelector(`[data-node="${id}"]`);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: (side === 'right' ? r.right : r.left) - box.left, y: r.top + r.height / 2 - box.top };
    };
    const next = graph.edges.flatMap((e) => {
      const a = anchor(e.from, 'right');
      const b = anchor(e.to, 'left');
      if (!a || !b) return [];
      const mid = (a.x + b.x) / 2;
      return [{ key: `${e.from}-${e.to}`, d: `M${a.x},${a.y} C${mid},${a.y} ${mid},${b.y} ${b.x},${b.y}`, tone: e.tone, lit: chain.has(e.from) && chain.has(e.to) }];
    });
    setPaths(next);
  }, [graph, chain]);

  useLayoutEffect(() => {
    measure();
    const ro = new ResizeObserver(measure);
    if (ref.current) ro.observe(ref.current);
    return () => ro.disconnect();
  }, [measure]);

  const dimmed = (id: string) => selectedId !== null && !chain.has(id);
  const stroke = (tone: string) =>
    tone === 'attention' ? 'var(--sam-status-warning-fg)' : tone === 'live' ? 'var(--sam-status-success-fg)' : 'var(--sam-color-fg-muted)';

  return (
    <div ref={ref} className="relative grid items-start gap-x-14 px-4 pb-6" style={{ gridTemplateColumns: 'minmax(150px, 0.8fr) minmax(240px, 1.4fr) minmax(220px, 1.1fr)' }}>
      <svg className="pointer-events-none absolute inset-0 h-full w-full overflow-visible" aria-hidden="true">
        {paths.map((p) => (
          <path
            key={p.key}
            d={p.d}
            fill="none"
            stroke={stroke(p.tone)}
            strokeWidth={p.lit ? 2.25 : 1.25}
            strokeOpacity={selectedId === null ? (p.tone === 'quiet' ? 0.3 : 0.6) : p.lit ? 1 : 0.1}
          />
        ))}
      </svg>
      {(['Projects', 'Chats and tasks', 'Machines'] as const).map((title) => (
        <h3 key={title} className="m-0 pb-2 pt-3 text-[11px] font-semibold uppercase tracking-wide text-fg-muted">
          {title}
        </h3>
      ))}
      <div className="flex flex-col gap-2">
        {graph.projects.map((p) => (
          <button
            key={p.id}
            type="button"
            data-node={p.id}
            onClick={() => select(p.id)}
            className={`flex min-w-0 cursor-pointer items-center gap-2 rounded-[var(--sam-radius-control)] border px-2.5 py-2 text-left transition-opacity ${
              selectedId === p.id ? 'sam-raised border-[var(--sam-success-edge)]' : 'border-[var(--sam-chip-edge)] bg-[var(--sam-chip-bg)]'
            } ${dimmed(p.id) ? 'opacity-40' : ''}`}
          >
            <ProjectMark name={p.name} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-medium text-fg-primary">{p.name}</span>
              <span className="block truncate text-[11px] text-fg-muted">{p.openIdeas} ideas · active {p.lastActive}</span>
            </span>
          </button>
        ))}
        {scene.quietProjectCount > 0 && (
          <p className="m-0 px-1 text-[12px] text-fg-muted">+ {scene.quietProjectCount} quiet projects</p>
        )}
      </div>
      <div className="flex flex-col gap-2">
        {graph.work.length === 0 && <p className="m-0 text-[13px] text-fg-muted">Nothing here.</p>}
        {graph.work.map((w) => (
          <WorkRow key={w.id} w={w} dim={dimmed(w.id)} selected={selectedId === w.id} onSelect={() => select(w.id)} />
        ))}
      </div>
      <div className="flex flex-col gap-2.5">
        {graph.machines.map((m) => {
          const hosted = scene.workspaces.filter((ws) => ws.machineId === m.id);
          return (
            <div
              key={m.id}
              className={`rounded-[var(--sam-radius-control)] border bg-[var(--sam-chip-bg)] p-2 transition-opacity ${
                m.state === 'unhealthy' ? 'border-[var(--sam-danger-edge)]' : 'border-[var(--sam-chip-edge)]'
              } ${dimmed(m.id) ? 'opacity-40' : ''}`}
            >
              <button type="button" onClick={() => select(m.id)} className="flex w-full min-w-0 cursor-pointer items-center gap-2 border-0 bg-transparent p-1 text-left">
                <MachineIcon machine={m} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-mono text-[12.5px] font-semibold text-fg-primary">{m.name}</span>
                  <span className="block truncate text-[11px] text-fg-muted">
                    {m.instant ? 'Cloudflare containers' : `${m.provider} · ${m.size} · ${formatCost(m.costPerHour)}`}
                  </span>
                </span>
                <MachineStateChip machine={m} />
              </button>
              {hosted.length === 0 ? (
                <p className="m-0 px-1 pb-1 pt-0.5 text-[11.5px] text-fg-muted">{m.note ?? 'No workspaces'}</p>
              ) : (
                hosted.map((ws) => (
                  <div key={ws.id} data-node={ws.id} className="sam-well mt-1.5 flex min-w-0 items-center gap-1.5 rounded-[9px] px-2 py-1.5 text-[11.5px] text-fg-muted">
                    <GitBranch size={11} className="shrink-0" aria-hidden="true" />
                    <span className="min-w-0 flex-1 truncate font-mono">{ws.branch}</span>
                    <span className="shrink-0 truncate">{project(ws.projectId)?.name.slice(0, 12)}</span>
                  </div>
                ))
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function MobileList({ scene, graph, selectedId, select }: { scene: MockScene; graph: Graph; selectedId: string | null; select: (id: string) => void }) {
  const { machineForWork } = lookup(scene);
  return (
    <div className="flex flex-col gap-2.5">
      {graph.projects
        .filter((p) => graph.work.some((w) => w.projectId === p.id))
        .map((p) => (
          <Pane key={p.id} className="px-3 py-3">
            <div className="mb-2 flex min-w-0 items-center gap-2 px-1">
              <ProjectMark name={p.name} />
              <span className="min-w-0 flex-1 truncate text-[14px] font-semibold text-fg-primary">{p.name}</span>
            </div>
            <div className="flex flex-col gap-2">
              {graph.work
                .filter((w) => w.projectId === p.id)
                .map((w) => {
                  const m = machineForWork(w);
                  const open = selectedId === w.id;
                  return (
                    <div key={w.id}>
                      <WorkRow w={w} dim={false} selected={open} onSelect={() => select(w.id)} />
                      {!open && (
                        <p className={`m-0 truncate px-3 pt-1 text-[11.5px] ${m?.state === 'unhealthy' ? 'text-[var(--sam-status-danger-fg)]' : 'text-fg-muted'}`}>
                          {m ? `on ${m.instant ? 'Instant' : m.name}${m.state === 'unhealthy' ? ' · not responding' : ''}` : 'not running anywhere'}
                        </p>
                      )}
                      {open && (
                        <div className="px-1 pt-2">
                          <div className="flex items-center gap-2 pb-2">
                            <WorkStateChip state={w.state} />
                            {m && <MachineStateChip machine={m} />}
                          </div>
                          <PathBarVertical scene={scene} w={w} />
                        </div>
                      )}
                    </div>
                  );
                })}
            </div>
          </Pane>
        ))}
    </div>
  );
}

function PathBarVertical({ scene, w }: { scene: MockScene; w: MockWork }) {
  const { workspace, machineForWork } = lookup(scene);
  const ws = workspace(w.workspaceId);
  const m = machineForWork(w);
  const steps = [
    ...(w.idea ? [['Idea', w.idea]] : []),
    ['Workspace', ws ? ws.branch : 'none (finished or asleep)'],
    ...(m ? [['Machine', m.instant ? 'Instant container' : `${m.name} · ${m.provider} ${m.location} · ${formatCost(m.costPerHour)}`]] : []),
    ...(w.pr ? [['Pull request', `#${w.pr.number} ${w.pr.state}`]] : []),
  ];
  return (
    <ol className="m-0 list-none border-l-2 border-solid border-[var(--sam-success-edge)] p-0 pl-3">
      {steps.map(([label, value]) => (
        <li key={label} className="pb-2">
          <span className="block text-[10px] uppercase tracking-wide text-fg-muted">{label}</span>
          <span className="block break-words text-[13px] text-fg-primary">{value}</span>
        </li>
      ))}
    </ol>
  );
}

export function DirectionB({ scene, isMobile }: { scene: MockScene; isMobile: boolean }) {
  const [filter, setFilter] = useState<Filter>('all');
  const [selectedId, setSelectedId] = useState<string | null>(scene.attention[0]?.workId ?? null);
  const graph = useMemo(() => buildGraph(scene, filter), [scene, filter]);
  const chain = useMemo(() => chainOf(scene, selectedId), [scene, selectedId]);
  const select = useCallback((id: string) => setSelectedId((cur) => (cur === id ? null : id)), []);
  const live = scene.work.filter((w) => w.state === 'working' || w.state === 'needs-you').length;

  const header = (
    <Pane variant="slab" as="header" className="flex flex-col gap-3 px-4 py-3.5 sm:px-5">
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="m-0 text-[22px] font-bold text-fg-primary sm:text-[24px]">How it all connects</h1>
          <p className="m-0 mt-1 text-[13.5px] text-fg-muted">Each chat, the project it belongs to, and the machine it runs on.</p>
        </div>
        <SegmentedControl<Filter>
          label="Show"
          value={filter}
          onChange={setFilter}
          className={isMobile ? 'w-full' : 'w-[340px]'}
          options={[
            { value: 'all', label: 'Everything', count: scene.work.length },
            { value: 'attention', label: 'Needs you', count: scene.attention.length },
            { value: 'live', label: 'Live', count: live },
          ]}
        />
      </div>
      {!isMobile && (
        <div className="flex min-h-[46px] items-center gap-3 border-t border-[var(--sam-hairline)] pt-3">
          <div className="min-w-0 flex-1">
            <PathBar scene={scene} selectedId={selectedId} />
          </div>
          {scene.work.some((w) => w.id === selectedId) && (
            <span className={buttonClassName({ size: 'sm', variant: 'accent' })}>Open chat</span>
          )}
        </div>
      )}
    </Pane>
  );

  if (scene.work.length === 0 && scene.machines.length === 0) {
    return (
      <div className="flex flex-col gap-[var(--sam-space-gutter)]">
        {header}
        <Pane className="px-6 py-10 text-center">
          <p className="m-0 text-[15px] font-semibold text-fg-primary">Nothing to connect yet</p>
          <p className="m-0 mt-1 text-[13px] text-fg-muted">Start a chat in a project and you’ll see it here, linked to the machine it runs on.</p>
        </Pane>
      </div>
    );
  }

  if (isMobile) {
    return (
      <div className="flex flex-col gap-2.5 pb-6">
        {header}
        <MobileList scene={scene} graph={graph} selectedId={selectedId} select={select} />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-[var(--sam-space-gutter)]">
      {header}
      <Pane variant="quiet" className="min-h-0 flex-1 overflow-y-auto">
        <DesktopColumns scene={scene} graph={graph} chain={chain} selectedId={selectedId} select={select} />
      </Pane>
    </div>
  );
}
