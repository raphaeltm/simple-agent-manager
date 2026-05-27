import {
  Activity,
  AlertTriangle,
  Brain,
  CheckCircle2,
  ChevronRight,
  CircleDashed,
  ClipboardList,
  Eye,
  FileText,
  GitBranch,
  Info,
  Link as LinkIcon,
  Lock,
  MessageSquareText,
  PauseCircle,
  Search,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  XCircle,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';

import {
  actions,
  memoryEntities,
  missions,
  policies,
  prototypeProject,
  type AgentAction,
  type ContextSection,
  type MemoryEntity,
  type MissionItem,
  type ProjectPolicy,
} from './mock-data';

const sectionTabs: Array<{ id: ContextSection; label: string; icon: ReactNode }> = [
  { id: 'overview', label: 'Overview', icon: <Eye size={16} /> },
  { id: 'memory', label: 'Memory', icon: <Brain size={16} /> },
  { id: 'policies', label: 'Policies', icon: <ShieldCheck size={16} /> },
  { id: 'actions', label: 'Agent actions', icon: <Activity size={16} /> },
  { id: 'missions', label: 'Missions', icon: <ClipboardList size={16} /> },
];

const categoryStyles: Record<ProjectPolicy['category'], string> = {
  rule: 'border-red-500/30 bg-red-500/10 text-red-200',
  constraint: 'border-amber-500/30 bg-amber-500/10 text-amber-200',
  delegation: 'border-sky-500/30 bg-sky-500/10 text-sky-200',
  preference: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200',
};

const statusStyles: Record<AgentAction['status'] | MissionItem['status'], string> = {
  succeeded: 'text-emerald-200 bg-emerald-500/10 border-emerald-500/30',
  failed: 'text-red-200 bg-red-500/10 border-red-500/30',
  blocked: 'text-amber-200 bg-amber-500/10 border-amber-500/30',
  pending: 'text-sky-200 bg-sky-500/10 border-sky-500/30',
  active: 'text-emerald-200 bg-emerald-500/10 border-emerald-500/30',
  paused: 'text-zinc-200 bg-zinc-500/10 border-zinc-500/30',
  completed: 'text-fg-muted bg-card-muted border-border-subtle',
};

const memoryTypeStyles: Record<MemoryEntity['type'], string> = {
  preference: 'bg-blue-500/10 text-blue-200 border-blue-500/30',
  context: 'bg-amber-500/10 text-amber-200 border-amber-500/30',
  workflow: 'bg-emerald-500/10 text-emerald-200 border-emerald-500/30',
  expertise: 'bg-purple-500/10 text-purple-200 border-purple-500/30',
  custom: 'bg-zinc-500/10 text-zinc-200 border-zinc-500/30',
};

function Badge({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <span className={`inline-flex min-h-6 items-center gap-1 rounded-sm border px-2 py-0.5 text-xs font-medium leading-tight ${className}`}>
      {children}
    </span>
  );
}

function Panel({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <section className={`rounded-md border border-border-subtle bg-card p-3 md:p-4 ${className}`}>{children}</section>;
}

function Metric({ label, value, icon }: { label: string; value: string; icon: ReactNode }) {
  return (
    <Panel className="min-w-0">
      <div className="flex items-center gap-2 text-fg-muted text-xs">
        {icon}
        <span className="truncate">{label}</span>
      </div>
      <div className="mt-2 text-2xl font-semibold text-fg-primary leading-none">{value}</div>
    </Panel>
  );
}

function SectionHeader({ title, description }: { title: string; description: string }) {
  return (
    <div className="min-w-0">
      <h2 className="m-0 text-base font-semibold text-fg-primary">{title}</h2>
      <p className="m-0 mt-1 text-sm text-fg-muted leading-6 max-w-3xl">{description}</p>
    </div>
  );
}

function PolicyCard({ policy }: { policy: ProjectPolicy }) {
  return (
    <article className={`rounded-md border p-3 ${policy.active ? 'border-border-subtle bg-card' : 'border-border-subtle bg-card-muted opacity-75'}`}>
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Badge className={categoryStyles[policy.category]}>{policy.category}</Badge>
            <Badge className={policy.active ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200' : 'border-zinc-500/30 bg-zinc-500/10 text-zinc-300'}>
              {policy.active ? 'active' : 'inactive'}
            </Badge>
            <Badge className="border-violet-500/30 bg-violet-500/10 text-violet-200">Instruction-only</Badge>
          </div>
          <h3 className="m-0 mt-3 text-sm font-semibold text-fg-primary leading-6 break-words">{policy.title}</h3>
          <p className="m-0 mt-2 text-sm text-fg-muted leading-6 break-words">{policy.content}</p>
        </div>
        <div className="flex shrink-0 flex-row gap-2 md:flex-col md:items-end">
          <Badge className="border-border-subtle bg-card-muted text-fg-muted">{Math.round(policy.confidence * 100)}%</Badge>
          <Badge className="border-border-subtle bg-card-muted text-fg-muted">{policy.source}</Badge>
        </div>
      </div>
      <div className="mt-3 flex flex-col gap-2 border-t border-border-subtle pt-3 text-xs text-fg-muted sm:flex-row sm:items-center sm:justify-between">
        <span className="min-w-0 break-words">Source: {policy.sourceLabel}</span>
        <span className="shrink-0">Updated {policy.updatedAt}</span>
      </div>
    </article>
  );
}

function MemoryCard({ entity }: { entity: MemoryEntity }) {
  return (
    <article className="rounded-md border border-border-subtle bg-card p-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Badge className={memoryTypeStyles[entity.type]}>{entity.type}</Badge>
            <Badge className="border-border-subtle bg-card-muted text-fg-muted">{entity.source}</Badge>
          </div>
          <h3 className="m-0 mt-3 text-sm font-semibold text-fg-primary leading-6 break-words">{entity.name}</h3>
          <p className="m-0 mt-2 text-sm text-fg-muted leading-6 break-words">{entity.summary}</p>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:w-32 sm:grid-cols-1">
          <div className="rounded-sm bg-card-muted p-2 text-xs text-fg-muted">
            <div className="text-fg-primary font-semibold">{entity.observationCount}</div>
            observations
          </div>
          <div className="rounded-sm bg-card-muted p-2 text-xs text-fg-muted">
            <div className="text-fg-primary font-semibold">{Math.round(entity.confidence * 100)}%</div>
            confidence
          </div>
        </div>
      </div>
      <div className="mt-3 flex flex-col gap-2 border-t border-border-subtle pt-3 text-xs text-fg-muted md:flex-row md:items-center md:justify-between">
        <span className="break-words">{entity.sourceLabel}</span>
        <span className="shrink-0">Confirmed {entity.lastConfirmed}</span>
      </div>
    </article>
  );
}

function ActionRow({ action }: { action: AgentAction }) {
  const icon = action.status === 'succeeded'
    ? <CheckCircle2 size={16} />
    : action.status === 'failed'
      ? <XCircle size={16} />
      : action.status === 'blocked'
        ? <AlertTriangle size={16} />
        : <CircleDashed size={16} />;

  return (
    <article className="rounded-md border border-border-subtle bg-card p-3">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Badge className={statusStyles[action.status]}>{icon}{action.status}</Badge>
            <Badge className="border-border-subtle bg-card-muted text-fg-muted">{action.tool}</Badge>
          </div>
          <h3 className="m-0 mt-3 text-sm font-semibold text-fg-primary leading-6 break-words">{action.label}</h3>
          <p className="m-0 mt-1 text-xs text-fg-muted break-words">Actor: {action.actor}</p>
          <p className="m-0 mt-1 text-xs text-fg-muted break-words">Target: {action.target}</p>
          <p className="m-0 mt-2 text-sm text-fg-muted leading-6 break-words">{action.summary}</p>
        </div>
        <div className="flex shrink-0 flex-col gap-2 text-xs text-fg-muted lg:items-end">
          <span>{action.timestamp}</span>
          <span className="break-words lg:max-w-48">{action.source}</span>
        </div>
      </div>
    </article>
  );
}

function MissionCard({ mission }: { mission: MissionItem }) {
  const icon = mission.status === 'active'
    ? <CircleDashed size={16} />
    : mission.status === 'paused'
      ? <PauseCircle size={16} />
      : mission.status === 'blocked'
        ? <AlertTriangle size={16} />
        : <CheckCircle2 size={16} />;

  return (
    <article className="rounded-md border border-border-subtle bg-card p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge className={statusStyles[mission.status]}>{icon}{mission.status}</Badge>
        <Badge className="border-border-subtle bg-card-muted text-fg-muted">{mission.tasks} tasks</Badge>
        <Badge className="border-border-subtle bg-card-muted text-fg-muted">{mission.handoffs} handoffs</Badge>
      </div>
      <h3 className="m-0 mt-3 text-sm font-semibold text-fg-primary leading-6 break-words">{mission.title}</h3>
      <p className="m-0 mt-2 text-sm text-fg-muted leading-6 break-words">{mission.summary}</p>
      <div className="mt-3 border-t border-border-subtle pt-3 text-xs text-fg-muted">Updated {mission.updatedAt}</div>
    </article>
  );
}

function Overview({ setActiveSection }: { setActiveSection: (section: ContextSection) => void }) {
  const activePolicyCount = policies.filter((p) => p.active).length;
  const failedActions = actions.filter((a) => a.status === 'failed' || a.status === 'blocked').length;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Metric label="Memory entities" value={String(memoryEntities.length)} icon={<Brain size={15} />} />
        <Metric label="Active policies" value={String(activePolicyCount)} icon={<ShieldCheck size={15} />} />
        <Metric label="Recent actions" value={String(actions.length)} icon={<Activity size={15} />} />
        <Metric label="Missions" value={String(missions.length)} icon={<ClipboardList size={15} />} />
      </div>

      <Panel>
        <div className="flex items-start gap-3">
          <Info className="mt-0.5 shrink-0 text-accent" size={18} />
          <div className="min-w-0">
            <h2 className="m-0 text-base font-semibold text-fg-primary">Project-scoped, not global control</h2>
            <p className="m-0 mt-1 text-sm leading-6 text-fg-muted">
              This prototype treats Agent Context as the project place to inspect what agents remember, which instruction-only policies apply, and what durable actions happened recently. It avoids a top-level control-center nav item.
            </p>
          </div>
        </div>
      </Panel>

      <div className="grid gap-3 xl:grid-cols-[1.1fr_0.9fr]">
        <Panel>
          <SectionHeader
            title="Needs attention"
            description="A compact queue of trust/debugging signals, not a complete operations dashboard."
          />
          <div className="mt-4 space-y-3">
            {actions.filter((a) => a.status === 'failed' || a.status === 'blocked' || a.status === 'pending').map((action) => (
              <button
                key={action.id}
                type="button"
                onClick={() => setActiveSection('actions')}
                className="flex min-h-12 w-full items-center justify-between gap-3 rounded-sm border border-border-subtle bg-card-muted p-3 text-left text-sm text-fg-primary hover:border-accent/40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus-ring"
              >
                <span className="min-w-0 break-words">{action.label}: <span className="text-fg-muted">{action.summary}</span></span>
                <ChevronRight className="shrink-0 text-fg-muted" size={16} />
              </button>
            ))}
            {failedActions === 0 && <p className="text-sm text-fg-muted">No attention items.</p>}
          </div>
        </Panel>

        <Panel>
          <SectionHeader
            title="Context stack preview"
            description="A future implementation could show the effective context sources without asking users to manage internals."
          />
          <div className="mt-4 space-y-2">
            {[
              ['Repository instructions', 'CLAUDE.md, AGENTS.md, .claude/rules'],
              ['Memory', `${memoryEntities.length} high-confidence entities`],
              ['Policies', `${activePolicyCount} active instruction-only policies`],
              ['Profiles', 'Linked from project profile settings'],
              ['Platform policy', 'Not implemented yet'],
            ].map(([title, detail]) => (
              <div key={title} className="flex items-start gap-3 rounded-sm bg-card-muted p-3">
                <FileText className="mt-0.5 shrink-0 text-fg-muted" size={16} />
                <div className="min-w-0">
                  <div className="text-sm font-medium text-fg-primary">{title}</div>
                  <div className="text-xs leading-5 text-fg-muted break-words">{detail}</div>
                </div>
              </div>
            ))}
          </div>
        </Panel>
      </div>
    </div>
  );
}

function FilterBox({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <label className="flex min-h-11 items-center gap-2 rounded-sm border border-border-subtle bg-card px-3 text-sm text-fg-muted focus-within:border-accent/50">
      <Search size={16} className="shrink-0" />
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="Filter this prototype data"
        className="min-w-0 flex-1 bg-transparent text-fg-primary outline-none placeholder:text-fg-muted"
      />
    </label>
  );
}

export function AgentContextPrototype() {
  const [activeSection, setActiveSection] = useState<ContextSection>('overview');
  const [filter, setFilter] = useState('');

  const normalizedFilter = filter.trim().toLowerCase();
  const visiblePolicies = useMemo(
    () => policies.filter((item) => `${item.title} ${item.content} ${item.category}`.toLowerCase().includes(normalizedFilter)),
    [normalizedFilter],
  );
  const visibleMemory = useMemo(
    () => memoryEntities.filter((item) => `${item.name} ${item.summary} ${item.type}`.toLowerCase().includes(normalizedFilter)),
    [normalizedFilter],
  );
  const visibleActions = useMemo(
    () => actions.filter((item) => `${item.tool} ${item.label} ${item.summary} ${item.actor}`.toLowerCase().includes(normalizedFilter)),
    [normalizedFilter],
  );
  const visibleMissions = useMemo(
    () => missions.filter((item) => `${item.title} ${item.summary} ${item.status}`.toLowerCase().includes(normalizedFilter)),
    [normalizedFilter],
  );

  return (
    <div style={{ height: '100vh', overflow: 'auto' }} className="bg-bg-primary text-fg-primary">
      <div className="mx-auto flex min-h-full w-full max-w-[88rem] flex-col px-3 py-3 sm:px-4 md:px-6 md:py-5">
        <header className="rounded-md border border-border-subtle bg-card p-4 md:p-5">
          <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2 text-xs text-fg-muted">
                <Badge className="border-accent/30 bg-accent/10 text-accent">Prototype</Badge>
                <span className="inline-flex items-center gap-1"><GitBranch size={13} /> {prototypeProject.branch}</span>
              </div>
              <h1 className="m-0 mt-3 text-2xl font-semibold leading-tight text-fg-primary md:text-3xl">Agent Context</h1>
              <p className="m-0 mt-2 max-w-4xl text-sm leading-6 text-fg-muted md:text-base">
                {prototypeProject.description}
              </p>
              <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-fg-muted">
                <span className="inline-flex items-center gap-1 break-all"><LinkIcon size={13} /> {prototypeProject.repo}</span>
                <span className="inline-flex items-center gap-1"><Lock size={13} /> Project scoped</span>
                <span className="inline-flex items-center gap-1"><ShieldAlert size={13} /> Policies are instruction-only today</span>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2 text-xs md:min-w-72">
              <div className="rounded-sm bg-card-muted p-3">
                <div className="text-fg-muted">Current project</div>
                <div className="mt-1 font-medium text-fg-primary break-words">{prototypeProject.name}</div>
              </div>
              <div className="rounded-sm bg-card-muted p-3">
                <div className="text-fg-muted">Runtime enforcement</div>
                <div className="mt-1 font-medium text-amber-200">Not yet</div>
              </div>
            </div>
          </div>
        </header>

        <div className="sticky top-0 z-10 -mx-3 mt-3 border-y border-border-subtle bg-bg-primary/95 px-3 py-2 backdrop-blur sm:-mx-4 sm:px-4 md:-mx-6 md:px-6">
          <div className="flex gap-2 overflow-x-auto pb-1">
            {sectionTabs.map((tab) => {
              const active = tab.id === activeSection;
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setActiveSection(tab.id)}
                  className={`flex min-h-10 shrink-0 items-center gap-2 rounded-sm border px-3 text-sm font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus-ring ${
                    active
                      ? 'border-accent/50 bg-accent/10 text-accent'
                      : 'border-border-subtle bg-card text-fg-muted hover:text-fg-primary'
                  }`}
                >
                  {tab.icon}
                  {tab.label}
                </button>
              );
            })}
          </div>
        </div>

        <main className="mt-4 flex-1 space-y-4 pb-8">
          {activeSection !== 'overview' && <FilterBox value={filter} onChange={setFilter} />}

          {activeSection === 'overview' && <Overview setActiveSection={setActiveSection} />}

          {activeSection === 'memory' && (
            <div className="space-y-3">
              <SectionHeader
                title="Memory"
                description="Project knowledge that agents may receive or search before making decisions. Long names and observations should wrap without horizontal scroll."
              />
              {visibleMemory.map((entity) => <MemoryCard key={entity.id} entity={entity} />)}
            </div>
          )}

          {activeSection === 'policies' && (
            <div className="space-y-3">
              <SectionHeader
                title="Policies"
                description="Durable project instructions and preferences. This prototype labels them honestly as instruction-only until SAM platform policy enforcement exists."
              />
              {visiblePolicies.map((policy) => <PolicyCard key={policy.id} policy={policy} />)}
            </div>
          )}

          {activeSection === 'actions' && (
            <div className="space-y-3">
              <SectionHeader
                title="Recent agent actions"
                description="A future audit/trust feed for durable state changes and surprising MCP calls. Current data is intentionally mock-heavy."
              />
              {visibleActions.map((action) => <ActionRow key={action.id} action={action} />)}
            </div>
          )}

          {activeSection === 'missions' && (
            <div className="space-y-3">
              <SectionHeader
                title="Missions"
                description="Missions stay contextual. They appear here only because this project has mission activity; they are not promoted into a global dashboard."
              />
              {visibleMissions.map((mission) => <MissionCard key={mission.id} mission={mission} />)}
            </div>
          )}

          {activeSection !== 'overview' && (
            <Panel className="border-dashed">
              <div className="flex items-start gap-3">
                <SlidersHorizontal className="mt-0.5 shrink-0 text-fg-muted" size={18} />
                <p className="m-0 text-sm leading-6 text-fg-muted">
                  Empty-state preview: if this filter returns no rows, production should explain whether the project truly has no data or whether the current filter hides it. Current visible rows: {
                    activeSection === 'memory'
                      ? visibleMemory.length
                      : activeSection === 'policies'
                        ? visiblePolicies.length
                        : activeSection === 'actions'
                          ? visibleActions.length
                          : visibleMissions.length
                  }.
                </p>
              </div>
            </Panel>
          )}
        </main>

        <footer className="border-t border-border-subtle py-4 text-xs text-fg-muted">
          <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
            <span className="inline-flex items-center gap-2"><Sparkles size={14} /> Prototype route: /prototype/agent-context</span>
            <span className="inline-flex items-center gap-2"><MessageSquareText size={14} /> Mock data only, no auth, no API calls</span>
          </div>
        </footer>
      </div>
    </div>
  );
}
