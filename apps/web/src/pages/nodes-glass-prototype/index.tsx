// PROTOTYPE ONLY — /prototype/nodes-glass. Four ideas for the Nodes page, built on the
// SAM Glass shell with fake data. No API calls, no auth.
//
// Remove before merging to main: delete this directory and the route + lazy import in
// apps/web/src/App.tsx.
import { Button, NavItem, Pane, SegmentedControl } from '@simple-agent-manager/ui';
import {
  Bell,
  FolderKanban,
  History,
  Home,
  Menu,
  MessageSquare,
  Plus,
  Server,
  Settings,
} from 'lucide-react';
import { useSearchParams } from 'react-router';

import { useIsMobile } from '../../hooks/useIsMobile';
import { ConceptCost } from './ConceptCost';
import { ConceptFill } from './ConceptFill';
import { ConceptLive } from './ConceptLive';
import { ConceptSessions } from './ConceptSessions';
import { MACHINES } from './mock-data';

type Concept = 'fill' | 'live' | 'sessions' | 'cost';

const CONCEPTS: Record<Concept, { label: string; long: string }> = {
  fill: { label: 'Fill', long: 'Fill levels' },
  live: { label: 'Live', long: 'Live' },
  sessions: { label: 'List', long: 'Sessions first' },
  cost: { label: 'Cost', long: 'Cost' },
};

function isConcept(value: string | null): value is Concept {
  return value !== null && value in CONCEPTS;
}

function Sidebar() {
  return (
    <aside
      aria-label="Sidebar"
      className="sam-glass sam-glass-rim flex min-h-0 flex-col gap-1 rounded-[var(--sam-radius-pane)] p-3"
    >
      <div className="flex items-center justify-between pb-2">
        <img src="/sam-head.png" alt="SAM" className="h-8 w-8 object-contain" />
      </div>
      <NavItem label="Home" icon={<Home size={18} strokeWidth={1.75} />} />
      <NavItem label="Projects" icon={<FolderKanban size={18} strokeWidth={1.75} />} />
      <NavItem label="Chats" icon={<MessageSquare size={18} strokeWidth={1.75} />} count={7} />
      <NavItem label="Nodes" icon={<Server size={18} strokeWidth={1.75} />} current />
      <NavItem label="Settings" icon={<Settings size={18} strokeWidth={1.75} />} />
    </aside>
  );
}

function MobileBar() {
  return (
    <header className="sam-glass sam-glass--slab sam-glass-rim flex h-14 shrink-0 items-center gap-2 rounded-[var(--sam-radius-slab)] px-2">
      <button
        type="button"
        aria-label="Menu"
        className="grid h-11 w-11 place-items-center rounded-[12px] border-0 bg-transparent text-fg-muted"
      >
        <Menu size={20} strokeWidth={1.75} />
      </button>
      <img src="/sam-head.png" alt="" className="h-7 w-7 object-contain" />
      <span className="min-w-0 flex-1 truncate text-[15px] font-semibold text-fg-primary">
        Nodes
      </span>
      <div className="sam-well flex rounded-[12px]">
        <button
          type="button"
          aria-label="Recent chats"
          className="grid h-11 w-11 place-items-center border-0 bg-transparent text-fg-muted"
        >
          <History size={18} strokeWidth={1.75} />
        </button>
        <button
          type="button"
          aria-label="Notifications"
          className="grid h-11 w-11 place-items-center border-0 bg-transparent text-fg-muted"
        >
          <Bell size={18} strokeWidth={1.75} />
        </button>
      </div>
    </header>
  );
}

export function NodesGlassPrototype() {
  const isMobile = useIsMobile();
  const [params, setParams] = useSearchParams();
  const raw = params.get('concept');
  const concept: Concept = isConcept(raw) ? raw : 'fill';
  const setConcept = (next: Concept) => setParams({ concept: next }, { replace: true });

  const content = (
    <div
      className="flex flex-col gap-[var(--sam-space-gutter)] p-3 md:p-5"
      data-prototype="nodes-glass"
    >
      <Pane variant="slab" as="header" className="flex flex-col gap-3 p-4 md:p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="m-0 font-mono text-[11px] uppercase tracking-wide text-fg-muted">
              Infrastructure / Nodes
            </p>
            <h1 className="m-0 mt-1 flex items-center gap-2.5 text-[24px] font-bold text-fg-primary">
              Nodes
              <span className="rounded-full bg-[var(--sam-color-warning)] px-2 py-0.5 font-mono text-[10px] font-bold uppercase text-[var(--sam-attention-ink)]">
                Prototype
              </span>
            </h1>
            <p className="m-0 mt-1 text-[13.5px] text-fg-muted">
              The machines your agents run on, which sessions are on each, and what they are using.
            </p>
          </div>
          <Button size="sm" className="shrink-0">
            <Plus size={14} />
            {isMobile ? 'New' : 'New node'}
          </Button>
        </div>
        <div className="flex">
          <SegmentedControl
            label="Concept"
            value={concept}
            onChange={setConcept}
            options={(Object.keys(CONCEPTS) as Concept[]).map((key) => ({
              value: key,
              label: isMobile ? CONCEPTS[key].label : CONCEPTS[key].long,
            }))}
            className="w-full md:w-[480px]"
          />
        </div>
      </Pane>
      {concept === 'fill' && <ConceptFill machines={MACHINES} />}
      {concept === 'live' && <ConceptLive machines={MACHINES} />}
      {concept === 'sessions' && <ConceptSessions machines={MACHINES} />}
      {concept === 'cost' && <ConceptCost machines={MACHINES} />}
    </div>
  );

  if (isMobile) {
    return (
      <div className="sam-void flex h-screen flex-col gap-2.5 p-2.5">
        <MobileBar />
        <div className="sam-glass sam-glass-rim flex min-h-0 flex-1 flex-col overflow-hidden rounded-[var(--sam-radius-pane)]">
          <main
            data-scroll="prototype"
            className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto"
          >
            {content}
          </main>
        </div>
      </div>
    );
  }

  return (
    <div
      className="sam-void grid h-screen gap-[var(--sam-space-gutter)] overflow-hidden p-4"
      style={{ gridTemplateColumns: '232px minmax(0, 1fr)', ['--sam-void-x' as string]: '58%' }}
    >
      <Sidebar />
      <div className="sam-glass sam-glass-rim flex min-h-0 min-w-0 flex-col overflow-hidden rounded-[var(--sam-radius-pane)]">
        <main data-scroll="prototype" className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
          {content}
        </main>
      </div>
    </div>
  );
}
