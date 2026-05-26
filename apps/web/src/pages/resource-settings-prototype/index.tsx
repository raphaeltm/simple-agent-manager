import { Button, Card, Input } from '@simple-agent-manager/ui';
import {
  Bot,
  CalendarClock,
  Check,
  ChevronRight,
  Cpu,
  HardDrive,
  MessageSquare,
  MonitorCog,
  SlidersHorizontal,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { useMemo, useState } from 'react';

import { nodeMath, resourcePresets, type ResourcePreset, type ResourcePresetId, touchpoints } from './mock-data';

type TouchpointId = 'all' | 'start' | 'profile' | 'project' | 'trigger' | 'admin';

const touchpointIds = ['start', 'profile', 'project', 'trigger', 'admin'] as const;

const iconByTouchpoint = {
  start: MessageSquare,
  profile: Bot,
  project: MonitorCog,
  trigger: CalendarClock,
  admin: SlidersHorizontal,
};

export function ResourceSettingsPrototype() {
  const initialTouchpoint = getInitialTouchpoint();
  const screenshotMode = getScreenshotMode();
  const [activeTouchpoint, setActiveTouchpoint] = useState<TouchpointId>(initialTouchpoint);
  const [activePreset, setActivePreset] = useState<ResourcePresetId>('conversation');
  const selected = useMemo(
    () => resourcePresets.find((preset) => preset.id === activePreset) ?? resourcePresets[0]!,
    [activePreset],
  );

  return (
    <div
      data-prototype-scroll-root
      style={screenshotMode ? { minHeight: '100vh', overflow: 'visible' } : { height: '100vh', overflow: 'auto' }}
      className="min-h-screen bg-bg text-fg-primary"
    >
      <main data-prototype-content className="mx-auto flex w-full max-w-6xl flex-col gap-5 px-4 py-4 md:px-8 md:py-8">
        <Header activeTouchpoint={activeTouchpoint} />
        <TouchpointRail activeTouchpoint={activeTouchpoint} onSelect={setActiveTouchpoint} />
        <TouchpointPanels
          activeTouchpoint={activeTouchpoint}
          selected={selected}
          activePreset={activePreset}
          onSelectPreset={setActivePreset}
        />
      </main>
    </div>
  );
}

function getInitialTouchpoint(): TouchpointId {
  if (typeof window === 'undefined') return 'all';
  const requested = getSearchParams().get('touchpoint');
  return requested === 'all' || touchpointIds.includes(requested as (typeof touchpointIds)[number])
    ? (requested as TouchpointId)
    : 'all';
}

function getScreenshotMode() {
  if (typeof window === 'undefined') return false;
  return getSearchParams().get('screenshot') === '1';
}

function getSearchParams() {
  return new URLSearchParams(window.location.search);
}

function Header({ activeTouchpoint }: { activeTouchpoint: TouchpointId }) {
  return (
    <header className="flex flex-col gap-3 border-b border-border-default pb-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-accent">Prototype</p>
          <h1 className="mt-1 text-2xl font-semibold leading-tight md:text-4xl">{getTouchpointTitle(activeTouchpoint)}</h1>
        </div>
        <div className="rounded-md border border-border-default bg-surface px-3 py-2 text-right">
          <p className="text-xs text-fg-muted">Default profile</p>
          <p className="text-sm font-semibold">Conversational</p>
        </div>
      </div>
      <p className="max-w-3xl text-sm leading-6 text-fg-muted">
        Mobile-first mockup for editable resource presets across session start, agent profiles,
        project defaults, triggers, and admin placement debugging.
      </p>
    </header>
  );
}

function getTouchpointTitle(activeTouchpoint: TouchpointId) {
  if (activeTouchpoint === 'all') return 'Resource settings touchpoints';
  return touchpoints.find((item) => item.id === activeTouchpoint)?.title ?? 'Resource settings touchpoints';
}

function TouchpointRail({
  activeTouchpoint,
  onSelect,
}: {
  activeTouchpoint: TouchpointId;
  onSelect: (touchpoint: TouchpointId) => void;
}) {
  return (
    <nav aria-label="Prototype touchpoints" className="-mx-4 overflow-x-auto px-4">
      <div className="flex min-w-max gap-2 md:grid md:min-w-0 md:grid-cols-6">
        {[{ id: 'all', title: 'All touchpoints', summary: 'Complete flow' }, ...touchpoints].map((item) => {
          const Icon = item.id === 'all' ? SlidersHorizontal : iconByTouchpoint[item.id as keyof typeof iconByTouchpoint];
          const isActive = activeTouchpoint === item.id;
          return (
            <button
              key={item.id}
              className={`flex min-h-16 w-40 flex-col rounded-md border p-3 text-left md:w-auto ${
                isActive ? 'border-accent bg-accent-tint' : 'border-border-default bg-surface'
              }`}
              type="button"
              onClick={() => onSelect(item.id as TouchpointId)}
            >
              <span className="flex items-center gap-2 text-sm font-semibold">
                <Icon size={16} />
                {item.title}
              </span>
              <span className="mt-1 text-xs leading-4 text-fg-muted">{item.summary}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}


function TouchpointPanels({
  activeTouchpoint,
  selected,
  activePreset,
  onSelectPreset,
}: {
  activeTouchpoint: TouchpointId;
  selected: ResourcePreset;
  activePreset: ResourcePresetId;
  onSelectPreset: (preset: ResourcePresetId) => void;
}) {
  const showAll = activeTouchpoint === 'all';

  return (
    <section className="grid gap-4 lg:grid-cols-[1.05fr_0.95fr]">
      {(showAll || activeTouchpoint === 'start') && (
        <StartSessionPanel selected={selected} activePreset={activePreset} onSelect={onSelectPreset} />
      )}
      {(showAll || activeTouchpoint === 'profile') && <AgentProfilePanel selected={selected} />}
      {(showAll || activeTouchpoint === 'project') && <ProjectDefaultsPanel />}
      {(showAll || activeTouchpoint === 'trigger') && <TriggerPanel />}
      {(showAll || activeTouchpoint === 'admin') && <AdminMathPanel />}
    </section>
  );
}

function StartSessionPanel({
  selected,
  activePreset,
  onSelect,
}: {
  selected: ResourcePreset;
  activePreset: ResourcePresetId;
  onSelect: (preset: ResourcePresetId) => void;
}) {
  return (
    <Panel title="New chat / task start" eyebrow="Most specific override" icon={<MessageSquare size={18} />}>
      <div className="grid gap-3">
        <FieldLabel label="Agent profile">
          <button className="flex min-h-12 w-full items-center justify-between rounded-md border border-border-default bg-inset px-3 text-left">
            <span>
              <span className="block text-sm font-semibold">Conversational</span>
              <span className="block text-xs text-fg-muted">Only built-in default profile</span>
            </span>
            <ChevronRight size={18} />
          </button>
        </FieldLabel>
        <FieldLabel label="Resources">
          <PresetGrid activePreset={activePreset} onSelect={onSelect} />
        </FieldLabel>
        <EditableResourceFields selected={selected} />
        <ResolvedSummary selected={selected} source="session override" />
        <Button className="w-full" size="lg">
          Start with these settings
        </Button>
      </div>
    </Panel>
  );
}

function AgentProfilePanel({ selected }: { selected: ResourcePreset }) {
  return (
    <Panel title="Agent profile defaults" eyebrow="User-created profile" icon={<Bot size={18} />}>
      <div className="grid gap-3">
        <FieldLabel label="Profile name">
          <Input defaultValue="Frontend implementer with a very long custom name" />
        </FieldLabel>
        <div className="grid grid-cols-2 gap-2">
          <ToggleCard label="Workspace" value="Full" />
          <ToggleCard label="Task mode" value="Task" />
        </div>
        <ProfileResourcePreview selected={selected} />
        <p className="rounded-md border border-border-default bg-inset p-3 text-xs leading-5 text-fg-muted">
          New sessions inherit these values. The start panel can override them without mutating the profile.
        </p>
      </div>
    </Panel>
  );
}

function ProjectDefaultsPanel() {
  return (
    <Panel title="Project defaults" eyebrow="Repo-specific reality" icon={<MonitorCog size={18} />}>
      <div className="grid gap-3">
        <DefaultRow label="Conversational sessions" value="0.2 vCPU / 512 MB" inherited="Platform default" />
        <DefaultRow label="Full workspace tasks" value="Heavy build/test" inherited="Project override" />
        <DefaultRow label="Node reserve" value="0.5 vCPU / 1.5 GB" inherited="Platform policy" />
        <div className="rounded-md border border-border-default bg-accent-tint p-3">
          <p className="text-sm font-semibold">Resolved for this repo</p>
          <p className="mt-1 text-xs leading-5 text-fg-muted">
            Full workspaces default to 4 vCPU and 8 GB because this project has a heavy devcontainer.
          </p>
        </div>
      </div>
    </Panel>
  );
}

function TriggerPanel() {
  return (
    <Panel title="Trigger setup" eyebrow="Unattended work" icon={<CalendarClock size={18} />}>
      <div className="grid gap-3">
        <div className="rounded-md border border-border-default bg-inset p-3">
          <p className="text-sm font-semibold">Nightly dependency updates</p>
          <p className="mt-1 text-xs text-fg-muted">Weekdays at 02:00 UTC</p>
        </div>
        <DefaultRow label="Agent profile" value="Maintenance" inherited="Trigger setting" />
        <DefaultRow label="Resources" value="Standard coding" inherited="Explicit override" />
        <DefaultRow label="Resolved reservation" value="2 vCPU / 4 GB" inherited="Persisted on task" />
        <p className="rounded-md border border-border-default bg-inset p-3 text-xs leading-5 text-fg-muted">
          Scheduled work shows cost/reliability settings up front because no one is watching when it starts.
        </p>
      </div>
    </Panel>
  );
}

function AdminMathPanel() {
  return (
    <Panel title="Placement debug" eyebrow="Admin-only" icon={<SlidersHorizontal size={18} />} wide>
      <div className="grid gap-3 md:grid-cols-[0.9fr_1.1fr]">
        <div className="grid gap-2">
          <MathRow label="Node" value={nodeMath.nodeName} />
          <MathRow label="Capacity" value={nodeMath.capacity} />
          <MathRow label="System reserve" value={nodeMath.reserve} />
          <MathRow label="Already reserved" value={nodeMath.existing} />
          <MathRow label="Incoming task" value={nodeMath.incoming} />
          <MathRow label="Remaining" value={nodeMath.remaining} strong />
        </div>
        <div className="rounded-md border border-border-default bg-inset p-3">
          <p className="text-sm font-semibold">Rejected candidates</p>
          <div className="mt-3 grid gap-2">
            {nodeMath.rejections.map((item) => (
              <div key={item.node} className="rounded-sm border border-border-default bg-surface p-2">
                <p className="text-xs font-semibold">{item.node}</p>
                <p className="mt-1 text-xs leading-4 text-fg-muted">{item.reason}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </Panel>
  );
}

function Panel({
  title,
  eyebrow,
  icon,
  children,
  wide = false,
}: {
  title: string;
  eyebrow: string;
  icon: ReactNode;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <Card className={`p-4 ${wide ? 'lg:col-span-2' : ''}`}>
      <div className="mb-4 flex items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-md border border-border-default bg-inset">
          {icon}
        </span>
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-fg-muted">{eyebrow}</p>
          <h2 className="text-lg font-semibold leading-tight">{title}</h2>
        </div>
      </div>
      {children}
    </Card>
  );
}

function PresetGrid({
  activePreset,
  onSelect,
}: {
  activePreset: ResourcePresetId;
  onSelect: (preset: ResourcePresetId) => void;
}) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
      {resourcePresets.map((preset) => (
        <button
          key={preset.id}
          type="button"
          aria-pressed={activePreset === preset.id}
          onClick={() => onSelect(preset.id)}
          className={`min-h-16 rounded-md border p-2 text-left transition ${
            activePreset === preset.id
              ? 'border-accent bg-accent-tint'
              : 'border-border-default bg-surface'
          }`}
        >
          <span className="flex items-center gap-1 text-sm font-semibold">
            {activePreset === preset.id ? <Check size={14} /> : null}
            {preset.shortLabel}
          </span>
          <span className="mt-1 block text-xs leading-4 text-fg-muted">{preset.cpu} vCPU</span>
        </button>
      ))}
    </div>
  );
}

function EditableResourceFields({ selected }: { selected: ResourcePreset }) {
  return (
    <div className="grid grid-cols-2 gap-2">
      <MetricInput icon={<Cpu size={15} />} label="Min vCPU" value={selected.cpu} />
      <MetricInput icon={<MonitorCog size={15} />} label="Memory" value={selected.memory} />
      <MetricInput icon={<HardDrive size={15} />} label="Disk" value={selected.disk} />
      <label className="flex min-h-16 items-center gap-3 rounded-md border border-border-default bg-inset px-3">
        <input type="checkbox" defaultChecked={selected.exclusive} className="size-4 accent-[var(--color-accent)]" />
        <span>
          <span className="block text-xs font-semibold text-fg-muted">Exclusive</span>
          <span className="block text-sm font-semibold">{selected.exclusive ? 'On' : 'Off'}</span>
        </span>
      </label>
    </div>
  );
}

function MetricInput({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <label className="rounded-md border border-border-default bg-inset p-2">
      <span className="mb-1 flex items-center gap-1 text-xs font-semibold text-fg-muted">
        {icon}
        {label}
      </span>
      <input
        defaultValue={value}
        className="min-h-8 w-full bg-transparent text-sm font-semibold text-fg-primary outline-none"
      />
    </label>
  );
}

function ResolvedSummary({ selected, source }: { selected: ResourcePreset; source: string }) {
  return (
    <div className="rounded-md border border-border-default bg-inset p-3">
      <p className="text-sm font-semibold">Resolved reservation</p>
      <p className="mt-1 text-xs leading-5 text-fg-muted">
        {selected.label} from {source}. {selected.placement}.
      </p>
    </div>
  );
}

function FieldLabel({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="grid gap-1">
      <span className="text-xs font-semibold uppercase tracking-wide text-fg-muted">{label}</span>
      {children}
    </label>
  );
}

function ToggleCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border-default bg-inset p-3">
      <p className="text-xs font-semibold text-fg-muted">{label}</p>
      <p className="mt-1 text-sm font-semibold">{value}</p>
    </div>
  );
}

function ProfileResourcePreview({ selected }: { selected: ResourcePreset }) {
  return (
    <div className="rounded-md border border-border-default bg-surface p-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-fg-muted">Default resources</p>
      <p className="mt-1 text-base font-semibold">{selected.label}</p>
      <p className="mt-1 text-xs leading-5 text-fg-muted">
        {selected.cpu} vCPU · {selected.memory} · {selected.disk}
      </p>
    </div>
  );
}

function DefaultRow({ label, value, inherited }: { label: string; value: string; inherited: string }) {
  return (
    <div className="flex min-h-14 items-center justify-between gap-3 rounded-md border border-border-default bg-inset p-3">
      <span>
        <span className="block text-sm font-semibold">{label}</span>
        <span className="block text-xs text-fg-muted">{inherited}</span>
      </span>
      <span className="max-w-[46%] text-right text-sm font-semibold leading-5">{value}</span>
    </div>
  );
}

function MathRow({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex min-h-12 items-center justify-between gap-3 rounded-md border border-border-default bg-inset px-3">
      <span className="text-sm text-fg-muted">{label}</span>
      <span className={`text-right text-sm ${strong ? 'font-bold text-accent' : 'font-semibold'}`}>{value}</span>
    </div>
  );
}
