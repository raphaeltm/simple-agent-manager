/**
 * Desktop Account Map: three columns (projects → chats and tasks → machines) with curved lines
 * between related items. Lines are measured from the rendered rows, so they follow wrapping
 * titles and window resizes without a layout engine.
 */
import { GitBranch } from 'lucide-react';
import { useCallback, useLayoutEffect, useRef, useState } from 'react';

import type { ConnectionsModel, ConnectionsView, MapEdge } from './connections-model';
import {
  machineDetail,
  MachineIcon,
  MachineStateChip,
  ProjectMark,
  WorkRow,
} from './connections-parts';

interface DrawnEdge {
  key: string;
  d: string;
  tone: MapEdge['tone'];
  lit: boolean;
}

const EDGE_COLOR: Record<MapEdge['tone'], string> = {
  attention: 'var(--sam-status-warning-fg)',
  live: 'var(--sam-status-success-fg)',
  quiet: 'var(--sam-color-fg-muted)',
};

function edgeOpacity(edge: DrawnEdge, hasSelection: boolean): number {
  if (hasSelection) return edge.lit ? 1 : 0.1;
  return edge.tone === 'quiet' ? 0.3 : 0.6;
}

export function ConnectionsColumns({
  model,
  view,
  chain,
  selectedId,
  onSelect,
  showQuiet,
  onToggleQuiet,
}: {
  model: ConnectionsModel;
  view: ConnectionsView;
  chain: Set<string>;
  selectedId: string | null;
  onSelect: (id: string) => void;
  showQuiet: boolean;
  onToggleQuiet: () => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState<DrawnEdge[]>([]);

  const measure = useCallback(() => {
    const root = rootRef.current;
    if (!root) return;
    const box = root.getBoundingClientRect();
    const anchors = new Map<string, DOMRect>();
    root.querySelectorAll<HTMLElement>('[data-node]').forEach((el) => {
      anchors.set(el.dataset.node ?? '', el.getBoundingClientRect());
    });
    const next: DrawnEdge[] = [];
    for (const e of view.edges) {
      const a = anchors.get(e.from);
      const b = anchors.get(e.to);
      if (!a || !b) continue;
      const x1 = a.right - box.left;
      const y1 = a.top + a.height / 2 - box.top;
      const x2 = b.left - box.left;
      const y2 = b.top + b.height / 2 - box.top;
      const mid = (x1 + x2) / 2;
      next.push({
        key: `${e.from}>${e.to}`,
        d: `M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2},${y2}`,
        tone: e.tone,
        lit: chain.has(e.from) && chain.has(e.to),
      });
    }
    setEdges(next);
  }, [view, chain]);

  useLayoutEffect(() => {
    measure();
    const root = rootRef.current;
    if (!root) return;
    // Rows change height as titles wrap, so watch the columns, not only the window.
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    root.querySelectorAll('[data-column]').forEach((col) => observer.observe(col));
    return () => observer.disconnect();
  }, [measure, showQuiet]);

  const dim = (id: string) => selectedId !== null && !chain.has(id);
  const projects = showQuiet ? [...view.projects, ...view.quietProjects] : view.projects;
  const projectName = (id: string | null) => model.projects.find((p) => p.id === id)?.name ?? '';

  return (
    <div
      ref={rootRef}
      data-testid="account-map-columns"
      className="relative grid items-start gap-x-14 px-4 pb-6"
      style={{
        gridTemplateColumns: 'minmax(150px, 0.8fr) minmax(240px, 1.4fr) minmax(220px, 1.1fr)',
      }}
    >
      <svg
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 h-full w-full overflow-visible"
      >
        {edges.map((e) => (
          <path
            key={e.key}
            data-edge={e.key}
            data-lit={e.lit ? 'true' : 'false'}
            d={e.d}
            fill="none"
            stroke={EDGE_COLOR[e.tone]}
            strokeWidth={e.lit ? 2.25 : 1.25}
            strokeOpacity={edgeOpacity(e, selectedId !== null)}
          />
        ))}
      </svg>

      {['Projects', 'Chats and tasks', 'Machines'].map((title) => (
        <h2
          key={title}
          className="m-0 pb-2 pt-3 text-[11px] font-semibold uppercase tracking-wide text-fg-muted"
        >
          {title}
        </h2>
      ))}

      <div data-column="projects" className="flex min-w-0 flex-col gap-2">
        {projects.map((p) => (
          <button
            key={p.id}
            type="button"
            data-node={p.id}
            aria-pressed={selectedId === p.id}
            onClick={() => onSelect(p.id)}
            className={`flex min-w-0 cursor-pointer items-center gap-2 rounded-[var(--sam-radius-control)] border border-solid px-2.5 py-2 text-left transition-opacity focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring ${
              selectedId === p.id
                ? 'sam-raised border-[var(--sam-success-edge)]'
                : 'border-[var(--sam-chip-edge)] bg-[var(--sam-chip-bg)]'
            } ${dim(p.id) ? 'opacity-40' : ''}`}
          >
            <ProjectMark name={p.name} />
            <span className="min-w-0 flex-1">
              <span className="line-clamp-2 break-words text-[13px] font-medium text-fg-primary [overflow-wrap:anywhere]">
                {p.name}
              </span>
              {p.repository && (
                <span className="block truncate text-[11px] text-fg-muted">{p.repository}</span>
              )}
            </span>
          </button>
        ))}
        {view.quietProjects.length > 0 && (
          <button
            type="button"
            onClick={onToggleQuiet}
            className="min-h-9 cursor-pointer rounded-[var(--sam-radius-control)] border-0 bg-transparent px-1 text-left text-[12px] text-fg-muted hover:text-fg-primary"
          >
            {showQuiet ? 'Hide quiet projects' : `Show ${view.quietProjects.length} quiet projects`}
          </button>
        )}
      </div>

      <div data-column="work" className="flex min-w-0 flex-col gap-2">
        {view.work.length === 0 && (
          <p className="m-0 text-[13px] text-fg-muted">No chats or tasks match.</p>
        )}
        {view.work.map((w) => (
          <WorkRow
            key={w.id}
            model={model}
            work={w}
            dim={dim(w.id)}
            selected={selectedId === w.id}
            onSelect={onSelect}
          />
        ))}
      </div>

      <div data-column="machines" className="flex min-w-0 flex-col gap-2.5">
        {view.machines.length === 0 && (
          <p className="m-0 text-[13px] text-fg-muted">No machines running.</p>
        )}
        {view.machines.map((m) => (
          <div
            key={m.id}
            className={`min-w-0 rounded-[var(--sam-radius-control)] border border-solid bg-[var(--sam-chip-bg)] p-2 transition-opacity ${
              m.status === 'error' || m.health === 'unhealthy'
                ? 'border-[var(--sam-danger-edge)]'
                : 'border-[var(--sam-chip-edge)]'
            } ${dim(m.id) ? 'opacity-40' : ''}`}
          >
            <button
              type="button"
              data-node={m.id}
              aria-pressed={selectedId === m.id}
              onClick={() => onSelect(m.id)}
              className="flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-[9px] border-0 bg-transparent p-1 text-left focus-visible:outline-2 focus-visible:outline-focus-ring"
            >
              <MachineIcon machine={m} />
              <span className="min-w-0 flex-1">
                <span
                  className={`block truncate text-[12.5px] font-semibold text-fg-primary ${m.placeholder ? '' : 'font-mono'}`}
                >
                  {m.name}
                </span>
                <span className="block truncate text-[11px] text-fg-muted">{machineDetail(m)}</span>
              </span>
              <MachineStateChip machine={m} />
            </button>
            {m.workspaces.length === 0 ? (
              <p className="m-0 px-1 pb-1 pt-0.5 text-[11.5px] text-fg-muted">No workspaces</p>
            ) : (
              m.workspaces.map((ws) => (
                <div
                  key={ws.id}
                  data-node={ws.id}
                  className="sam-well mt-1.5 flex min-w-0 items-center gap-1.5 rounded-[9px] px-2 py-1.5 text-[11.5px] text-fg-muted"
                >
                  <GitBranch size={11} aria-hidden="true" className="shrink-0" />
                  <span className="min-w-0 flex-1 truncate font-mono">{ws.label}</span>
                  <span className="max-w-[40%] shrink-0 truncate">{projectName(ws.projectId)}</span>
                </div>
              ))
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
