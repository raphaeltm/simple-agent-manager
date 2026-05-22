import { Card, Select, StatusBadge } from '@simple-agent-manager/ui';
import {
  AlertTriangle,
  ChevronDown,
  Cpu,
  Layout,
  Monitor,
  PanelRightOpen,
  Plus,
  Server,
  Settings,
  SquareTerminal,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { useMemo, useState } from 'react';

/* ------------------------------------------------------------------ */
/*  Types & mock data                                                  */
/* ------------------------------------------------------------------ */

type ProviderId = 'hetzner' | 'scaleway' | 'gcp';
type SizeId = 'small' | 'medium' | 'large';
type SurfaceId =
  | 'project-settings'
  | 'create-node'
  | 'create-workspace'
  | 'task-submit'
  | 'node-card'
  | 'settings-drawer';

interface LocationOption {
  id: string;
  label: string;
  country: string;
  policy: 'allowed' | 'blocked';
}

interface SizeOption {
  id: SizeId;
  label: string;
  type: string;
  price: string;
  vcpu: number;
  ramGb: number;
  storageGb: number;
}

interface ProviderOption {
  id: ProviderId;
  label: string;
  locations: LocationOption[];
  sizes: SizeOption[];
}

const providers: ProviderOption[] = [
  {
    id: 'hetzner',
    label: 'Hetzner',
    locations: [
      { id: 'fsn1', label: 'Falkenstein', country: 'DE', policy: 'allowed' },
      { id: 'nbg1', label: 'Nuremberg', country: 'DE', policy: 'allowed' },
      { id: 'ash', label: 'Ashburn', country: 'US', policy: 'blocked' },
    ],
    sizes: [
      { id: 'small', label: 'Small', type: 'cx22', price: '\u20ac4.35/mo', vcpu: 2, ramGb: 4, storageGb: 40 },
      { id: 'medium', label: 'Medium', type: 'cx32', price: '\u20ac7.69/mo', vcpu: 4, ramGb: 8, storageGb: 80 },
      { id: 'large', label: 'Large', type: 'cx42', price: '\u20ac14.49/mo', vcpu: 8, ramGb: 16, storageGb: 160 },
    ],
  },
  {
    id: 'scaleway',
    label: 'Scaleway',
    locations: [
      { id: 'fr-par-1', label: 'Paris 1', country: 'FR', policy: 'allowed' },
      { id: 'nl-ams-1', label: 'Amsterdam 1', country: 'NL', policy: 'allowed' },
      { id: 'pl-waw-1', label: 'Warsaw 1', country: 'PL', policy: 'allowed' },
    ],
    sizes: [
      { id: 'small', label: 'Small', type: 'DEV1-M', price: '~\u20ac0.024/hr', vcpu: 3, ramGb: 4, storageGb: 40 },
      { id: 'medium', label: 'Medium', type: 'DEV1-XL', price: '~\u20ac0.048/hr', vcpu: 4, ramGb: 12, storageGb: 80 },
      { id: 'large', label: 'Large', type: 'GP1-S', price: '~\u20ac0.084/hr', vcpu: 8, ramGb: 32, storageGb: 150 },
    ],
  },
  {
    id: 'gcp',
    label: 'Google Cloud',
    locations: [
      { id: 'us-central1-a', label: 'Iowa', country: 'US', policy: 'allowed' },
      { id: 'europe-west3-a', label: 'Frankfurt', country: 'DE', policy: 'allowed' },
      { id: 'asia-northeast1-a', label: 'Tokyo', country: 'JP', policy: 'allowed' },
    ],
    sizes: [
      { id: 'small', label: 'Small', type: 'e2-medium', price: '~$25/mo', vcpu: 1, ramGb: 4, storageGb: 50 },
      { id: 'medium', label: 'Medium', type: 'e2-standard-2', price: '~$49/mo', vcpu: 2, ramGb: 8, storageGb: 50 },
      { id: 'large', label: 'Large', type: 'e2-standard-4', price: '~$97/mo', vcpu: 4, ramGb: 16, storageGb: 50 },
    ],
  },
];

const surfaces: Array<{ id: SurfaceId; label: string; icon: ReactNode }> = [
  { id: 'project-settings', label: 'Project Settings', icon: <Settings size={16} /> },
  { id: 'create-node', label: 'Create Node', icon: <Server size={16} /> },
  { id: 'create-workspace', label: 'Create Workspace', icon: <SquareTerminal size={16} /> },
  { id: 'task-submit', label: 'Task Submit', icon: <Plus size={16} /> },
  { id: 'node-card', label: 'Node Card', icon: <Monitor size={16} /> },
  { id: 'settings-drawer', label: 'Settings Drawer', icon: <PanelRightOpen size={16} /> },
];

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function firstItem<T>(items: T[], label: string): T {
  const item = items[0];
  if (!item) throw new Error(`VM selection prototype requires at least one ${label}`);
  return item;
}

function getProvider(id: ProviderId): ProviderOption {
  return providers.find((p) => p.id === id) ?? firstItem(providers, 'provider');
}

function getSize(provider: ProviderOption, id: SizeId): SizeOption {
  return provider.sizes.find((s) => s.id === id) ?? firstItem(provider.sizes, 'size');
}

function getLocation(provider: ProviderOption, id: string): LocationOption {
  return provider.locations.find((l) => l.id === id) ?? firstItem(provider.locations, 'location');
}

function isProviderId(value: string): value is ProviderId {
  return providers.some((p) => p.id === value);
}

function isSizeId(provider: ProviderOption, value: string): value is SizeId {
  return provider.sizes.some((s) => s.id === value);
}

/* ------------------------------------------------------------------ */
/*  Shared sub-components                                              */
/* ------------------------------------------------------------------ */

function SurfaceTabs({ selected, onChange }: { selected: SurfaceId; onChange: (s: SurfaceId) => void }) {
  return (
    <div className="flex gap-2 overflow-x-auto pb-1" aria-label="Prototype screens">
      {surfaces.map((s) => (
        <button
          key={s.id}
          type="button"
          aria-pressed={selected === s.id}
          onClick={() => onChange(s.id)}
          className={`inline-flex min-h-11 shrink-0 items-center gap-2 rounded-sm border px-3 py-2 text-sm font-medium transition ${
            selected === s.id
              ? 'border-accent bg-accent-tint text-fg-primary'
              : 'border-border-default bg-surface text-fg-muted hover:text-fg-primary'
          }`}
        >
          {s.icon}
          {s.label}
        </button>
      ))}
    </div>
  );
}

function Field({ label, id, children }: { label: string; id: string; children: ReactNode }) {
  return (
    <label htmlFor={id} className="grid gap-1.5">
      <span className="text-sm font-medium text-fg-muted">{label}</span>
      {children}
    </label>
  );
}

function Note({ tone, children }: { tone: 'info' | 'warning'; children: ReactNode }) {
  const classes =
    tone === 'warning'
      ? 'border-warning/30 bg-warning-tint text-warning'
      : 'border-info/20 bg-info-tint text-info';
  return <div className={`rounded-sm border px-4 py-3 text-sm leading-6 ${classes}`}>{children}</div>;
}

/** Standardized size card used across all selection surfaces */
function SizeCard({
  size,
  selected,
  onClick,
  compact,
}: {
  size: SizeOption;
  selected: boolean;
  onClick: () => void;
  compact?: boolean;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={`rounded-sm border p-3 text-left transition ${
        selected ? 'border-accent bg-accent-tint' : 'border-border-default bg-surface hover:border-accent/60'
      } ${compact ? 'p-2' : 'p-3 min-h-[88px]'}`}
    >
      <span className="block text-sm font-semibold text-fg-primary">{size.label}</span>
      <span className="mt-0.5 block text-xs text-fg-muted">
        {size.type} &middot; {size.vcpu} vCPU &middot; {size.ramGb} GB
      </span>
      <span className="mt-0.5 block text-xs text-fg-muted">{size.price}</span>
    </button>
  );
}

/* ------------------------------------------------------------------ */
/*  1. Project Settings surface                                        */
/* ------------------------------------------------------------------ */

function ProjectSettingsSurface({
  provider,
  sizeId,
  locationId,
  onSize,
  onProvider,
  onLocation,
}: {
  provider: ProviderOption;
  sizeId: SizeId;
  locationId: string;
  onSize: (s: SizeId) => void;
  onProvider: (p: ProviderId) => void;
  onLocation: (l: string) => void;
}) {
  return (
    <div className="grid gap-4">
      <SectionLabel>Project Settings &rarr; Default Node Size</SectionLabel>

      <Card className="grid gap-4 p-4" variant="glass">
        <div>
          <h2 className="m-0 text-base font-semibold text-fg-primary">Default Node Size</h2>
          <p className="m-0 mt-1 text-xs text-fg-muted">
            Used when launching new workspaces from this project. Click again to clear.
          </p>
        </div>

        {/* Provider selector */}
        <Field label="Cloud Provider" id="ps-provider">
          <Select
            id="ps-provider"
            value={provider.id}
            onChange={(e) => {
              const next = e.currentTarget.value;
              if (!isProviderId(next)) return;
              const np = getProvider(next);
              onProvider(next);
              onLocation(firstItem(np.locations, 'location').id);
            }}
          >
            {providers.map((p) => (
              <option key={p.id} value={p.id}>{p.label}</option>
            ))}
          </Select>
        </Field>

        {/* Region selector */}
        <Field label="Default Region" id="ps-location">
          <Select id="ps-location" value={locationId} onChange={(e) => onLocation(e.currentTarget.value)}>
            {provider.locations.map((loc) => (
              <option key={loc.id} value={loc.id}>
                {loc.label}, {loc.country}
              </option>
            ))}
          </Select>
        </Field>

        {/* Size cards */}
        <div className="grid gap-2 sm:grid-cols-3">
          {provider.sizes.map((s) => (
            <SizeCard key={s.id} size={s} selected={s.id === sizeId} onClick={() => onSize(s.id)} />
          ))}
        </div>

        {sizeId && (
          <div className="text-xs text-fg-muted">
            New workspaces will default to{' '}
            <strong>{getSize(provider, sizeId).label} ({getSize(provider, sizeId).type})</strong> in{' '}
            <strong>{getLocation(provider, locationId).label}</strong>.
          </div>
        )}
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  2. Create Node surface                                             */
/* ------------------------------------------------------------------ */

function CreateNodeSurface({
  provider,
  sizeId,
  locationId,
  onSize,
  onProvider,
  onLocation,
}: {
  provider: ProviderOption;
  sizeId: SizeId;
  locationId: string;
  onSize: (s: SizeId) => void;
  onProvider: (p: ProviderId) => void;
  onLocation: (l: string) => void;
}) {
  const size = getSize(provider, sizeId);
  const location = getLocation(provider, locationId);

  return (
    <div className="grid gap-4">
      <SectionLabel>Nodes Page &rarr; Create Node Form</SectionLabel>

      <Card className="grid gap-4 p-4" variant="glass">
        {/* Provider */}
        <Field label="Cloud Provider" id="cn-provider">
          <Select
            id="cn-provider"
            value={provider.id}
            onChange={(e) => {
              const next = e.currentTarget.value;
              if (!isProviderId(next)) return;
              const np = getProvider(next);
              onProvider(next);
              onLocation(firstItem(np.locations, 'location').id);
            }}
          >
            {providers.map((p) => (
              <option key={p.id} value={p.id}>{p.label}</option>
            ))}
          </Select>
        </Field>

        {/* Size */}
        <div>
          <span className="block text-sm font-medium text-fg-muted mb-2">Node Size</span>
          <div className="grid gap-2 grid-cols-3">
            {provider.sizes.map((s) => (
              <SizeCard key={s.id} size={s} selected={s.id === sizeId} onClick={() => onSize(s.id)} />
            ))}
          </div>
        </div>

        {/* Location */}
        <Field label="Location" id="cn-location">
          <Select id="cn-location" value={locationId} onChange={(e) => onLocation(e.currentTarget.value)}>
            {provider.locations.map((loc) => (
              <option key={loc.id} value={loc.id}>
                {loc.label}, {loc.country}
              </option>
            ))}
          </Select>
        </Field>

        {/* Confirmation summary */}
        <div className="rounded-sm border border-border-default bg-inset p-3 grid gap-1 text-sm">
          <span className="text-xs font-medium uppercase text-fg-muted">Will provision</span>
          <span className="text-fg-primary font-medium">
            {provider.label} {size.type} &middot; {size.vcpu} vCPU &middot; {size.ramGb} GB RAM &middot; {size.storageGb} GB disk
          </span>
          <span className="text-fg-muted text-xs">
            {location.label}, {location.country} &middot; {size.price}
          </span>
        </div>

        <div className="flex justify-end">
          <button
            type="button"
            className="rounded-sm border border-accent bg-accent-tint px-4 py-2 text-sm font-medium text-fg-primary"
          >
            Create Node
          </button>
        </div>
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  3. Create Workspace surface                                        */
/* ------------------------------------------------------------------ */

function CreateWorkspaceSurface({
  provider,
  sizeId,
  locationId,
  onSize,
  onProvider,
  onLocation,
}: {
  provider: ProviderOption;
  sizeId: SizeId;
  locationId: string;
  onSize: (s: SizeId) => void;
  onProvider: (p: ProviderId) => void;
  onLocation: (l: string) => void;
}) {
  const size = getSize(provider, sizeId);

  return (
    <div className="grid gap-4">
      <SectionLabel>Create Workspace &rarr; VM Selection</SectionLabel>

      <Card className="grid gap-4 p-4" variant="glass">
        {/* Workspace name + repo (mock fields) */}
        <Field label="Workspace Name" id="cw-name">
          <input
            id="cw-name"
            type="text"
            value="my-feature-branch"
            readOnly
            className="rounded-sm border border-border-default bg-inset px-3 py-2 text-sm text-fg-primary"
          />
        </Field>

        <Field label="Repository" id="cw-repo">
          <input
            id="cw-repo"
            type="text"
            value="raphaeltm/simple-agent-manager"
            readOnly
            className="rounded-sm border border-border-default bg-inset px-3 py-2 text-sm text-fg-primary"
          />
        </Field>

        {/* Provider */}
        <Field label="Cloud Provider" id="cw-provider">
          <Select
            id="cw-provider"
            value={provider.id}
            onChange={(e) => {
              const next = e.currentTarget.value;
              if (!isProviderId(next)) return;
              const np = getProvider(next);
              onProvider(next);
              onLocation(firstItem(np.locations, 'location').id);
            }}
          >
            {providers.map((p) => (
              <option key={p.id} value={p.id}>{p.label}</option>
            ))}
          </Select>
        </Field>

        {/* VM size */}
        <div>
          <span className="block text-sm font-medium text-fg-muted mb-2">VM Size</span>
          <div className="grid gap-2 sm:grid-cols-3">
            {provider.sizes.map((s) => (
              <SizeCard key={s.id} size={s} selected={s.id === sizeId} onClick={() => onSize(s.id)} />
            ))}
          </div>
        </div>

        {/* Location */}
        <Field label="Node Location" id="cw-location">
          <Select id="cw-location" value={locationId} onChange={(e) => onLocation(e.currentTarget.value)}>
            {provider.locations.map((loc) => (
              <option key={loc.id} value={loc.id}>
                {loc.label}, {loc.country}
              </option>
            ))}
          </Select>
        </Field>

        {/* Summary */}
        <div className="rounded-sm border border-border-default bg-inset p-3 text-xs text-fg-muted">
          {provider.label} {size.type} &middot; {size.vcpu} vCPU, {size.ramGb} GB RAM &middot; {size.price}
        </div>

        <div className="flex justify-end gap-3">
          <button
            type="button"
            className="rounded-sm border border-border-default px-4 py-2 text-sm text-fg-muted"
          >
            Cancel
          </button>
          <button
            type="button"
            className="rounded-sm border border-accent bg-accent-tint px-4 py-2 text-sm font-medium text-fg-primary"
          >
            Create Workspace
          </button>
        </div>
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  4. Task Submit surface                                             */
/* ------------------------------------------------------------------ */

function TaskSubmitSurface({
  provider,
  sizeId,
  onSize,
}: {
  provider: ProviderOption;
  sizeId: SizeId;
  onSize: (s: SizeId) => void;
}) {
  const [showAdvanced, setShowAdvanced] = useState(true);
  const size = getSize(provider, sizeId);

  return (
    <div className="grid gap-4">
      <SectionLabel>Project Chat &rarr; Task Submit Form (Advanced Options)</SectionLabel>

      <Card className="grid gap-3 p-4" variant="glass">
        {/* Mock task description */}
        <div>
          <span className="block text-sm font-medium text-fg-muted mb-1">Task Description</span>
          <div className="rounded-sm border border-border-default bg-inset px-3 py-2 text-sm text-fg-primary min-h-[60px]">
            Fix the authentication bug in the login flow
          </div>
        </div>

        {/* Advanced toggle */}
        <button
          type="button"
          onClick={() => setShowAdvanced(!showAdvanced)}
          className="flex items-center gap-2 text-sm text-fg-muted hover:text-fg-primary"
        >
          <ChevronDown size={14} className={`transition ${showAdvanced ? 'rotate-0' : '-rotate-90'}`} />
          Advanced options
        </button>

        {showAdvanced && (
          <div className="grid gap-3 pl-4 border-l-2 border-border-default">
            <div className="grid gap-3 sm:grid-cols-2">
              {/* VM Size - now a proper selector instead of a bare dropdown */}
              <div>
                <span className="block text-xs text-fg-muted mb-1">VM Size Override</span>
                <Select
                  value={sizeId}
                  onChange={(e) => {
                    const next = e.currentTarget.value;
                    if (isSizeId(provider, next)) onSize(next);
                  }}
                >
                  <option value="">Project default</option>
                  {provider.sizes.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.label} — {s.type} ({s.vcpu} vCPU, {s.ramGb} GB) {s.price}
                    </option>
                  ))}
                </Select>
              </div>

              {/* Priority */}
              <div>
                <span className="block text-xs text-fg-muted mb-1">Priority</span>
                <Select value="0">
                  <option value="0">Normal (0)</option>
                  <option value="1">Low (1)</option>
                  <option value="5">Medium (5)</option>
                  <option value="10">High (10)</option>
                </Select>
              </div>
            </div>

            {/* Show resolved specs when size is selected */}
            {sizeId && (
              <div className="rounded-sm border border-border-default bg-inset p-2 text-xs text-fg-muted flex items-center gap-2">
                <Cpu size={12} />
                <span>
                  Override: {provider.label} {size.type} &middot; {size.vcpu} vCPU, {size.ramGb} GB RAM &middot; {size.price}
                </span>
              </div>
            )}
          </div>
        )}

        <div className="flex justify-end">
          <button
            type="button"
            className="rounded-sm border border-accent bg-accent-tint px-4 py-2 text-sm font-medium text-fg-primary"
          >
            Submit Task
          </button>
        </div>
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  5. Node Card surface (read-only display)                           */
/* ------------------------------------------------------------------ */

function NodeCardSurface({ provider, sizeId, locationId }: {
  provider: ProviderOption;
  sizeId: SizeId;
  locationId: string;
}) {
  const size = getSize(provider, sizeId);
  const location = getLocation(provider, locationId);

  return (
    <div className="grid gap-4">
      <SectionLabel>Nodes Page &rarr; Node Card (read-only display)</SectionLabel>

      <div className="grid gap-4 sm:grid-cols-2">
        {/* Current: vague labels */}
        <div className="grid gap-2">
          <span className="text-xs font-medium uppercase text-fg-muted">Current (vague)</span>
          <Card
            className="flex flex-col gap-3"
            variant="glass"
            style={{ padding: 'clamp(var(--sam-space-3), 3vw, var(--sam-space-4))' }}
          >
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-sm bg-info-tint flex items-center justify-center shrink-0">
                <Server size={20} color="var(--sam-color-info-fg)" />
              </div>
              <span className="text-sm font-semibold text-fg-primary">my-dev-node</span>
            </div>
            <div className="flex items-center gap-2">
              <StatusBadge status="running" />
              <StatusBadge status="healthy" />
            </div>
            {/* Current vague display */}
            <div className="text-xs text-fg-muted flex flex-wrap gap-x-1">
              <span>{provider.label}</span>
              <span>&middot;</span>
              <span>{size.label} &mdash; {size.vcpu} vCPUs, {size.ramGb} GB RAM</span>
              <span>&middot;</span>
              <span>{location.label}, {location.country}</span>
            </div>
          </Card>
        </div>

        {/* Proposed: exact specs */}
        <div className="grid gap-2">
          <span className="text-xs font-medium uppercase text-fg-muted">Proposed (exact)</span>
          <Card
            className="flex flex-col gap-3"
            variant="glass"
            style={{ padding: 'clamp(var(--sam-space-3), 3vw, var(--sam-space-4))' }}
          >
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-sm bg-info-tint flex items-center justify-center shrink-0">
                <Server size={20} color="var(--sam-color-info-fg)" />
              </div>
              <span className="text-sm font-semibold text-fg-primary">my-dev-node</span>
            </div>
            <div className="flex items-center gap-2">
              <StatusBadge status="running" />
              <StatusBadge status="healthy" />
            </div>
            {/* Proposed exact display */}
            <div className="text-xs text-fg-muted flex flex-wrap gap-x-1">
              <span>{provider.label}</span>
              <span>&middot;</span>
              <span className="font-medium text-fg-primary">{size.type}</span>
              <span>&middot;</span>
              <span>{size.vcpu} vCPU, {size.ramGb} GB RAM, {size.storageGb} GB disk</span>
              <span>&middot;</span>
              <span>{location.label}, {location.country}</span>
              <span>&middot;</span>
              <span>{size.price}</span>
            </div>
          </Card>
        </div>
      </div>

      <Note tone="info">
        Node cards currently show &quot;Small &mdash; 2 vCPUs, 4 GB RAM&quot; via a static label map.
        The proposed version shows the exact server type, specs, and price from the provider catalog.
      </Note>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  6. Settings Drawer surface                                         */
/* ------------------------------------------------------------------ */

function SettingsDrawerSurface({
  provider,
  sizeId,
  locationId,
  onSize,
  onProvider,
  onLocation,
}: {
  provider: ProviderOption;
  sizeId: SizeId;
  locationId: string;
  onSize: (s: SizeId) => void;
  onProvider: (p: ProviderId) => void;
  onLocation: (l: string) => void;
}) {
  return (
    <div className="grid gap-4">
      <SectionLabel>Project Chat &rarr; Settings Drawer</SectionLabel>

      {/* Simulated drawer panel */}
      <div className="max-w-md ml-auto">
        <Card className="grid gap-4 p-4 rounded-l-lg rounded-r-none border-r-0" variant="glass">
          <div className="flex items-center justify-between">
            <h2 className="m-0 text-base font-semibold text-fg-primary">Project Settings</h2>
            <button type="button" className="text-fg-muted hover:text-fg-primary text-sm">&times;</button>
          </div>

          {/* Default Node Size */}
          <section className="grid gap-3">
            <div>
              <h3 className="m-0 text-sm font-semibold text-fg-primary">Default Node Size</h3>
              <p className="m-0 mt-1 text-xs text-fg-muted">
                Used when launching new workspaces. Click again to clear.
              </p>
            </div>

            {/* Provider */}
            <Field label="Provider" id="sd-provider">
              <Select
                id="sd-provider"
                value={provider.id}
                onChange={(e) => {
                  const next = e.currentTarget.value;
                  if (!isProviderId(next)) return;
                  const np = getProvider(next);
                  onProvider(next);
                  onLocation(firstItem(np.locations, 'location').id);
                }}
              >
                {providers.map((p) => (
                  <option key={p.id} value={p.id}>{p.label}</option>
                ))}
              </Select>
            </Field>

            {/* Region */}
            <Field label="Region" id="sd-location">
              <Select id="sd-location" value={locationId} onChange={(e) => onLocation(e.currentTarget.value)}>
                {provider.locations.map((loc) => (
                  <option key={loc.id} value={loc.id}>
                    {loc.label}, {loc.country}
                  </option>
                ))}
              </Select>
            </Field>

            {/* Size cards (compact for drawer) */}
            <div className="grid grid-cols-3 gap-2">
              {provider.sizes.map((s) => (
                <SizeCard key={s.id} size={s} selected={s.id === sizeId} onClick={() => onSize(s.id)} compact />
              ))}
            </div>
          </section>

          {/* Mock other drawer sections */}
          <section className="grid gap-2 border-t border-border-default pt-3">
            <h3 className="m-0 text-sm font-semibold text-fg-muted">Workspace Profile</h3>
            <div className="grid grid-cols-2 gap-2">
              <div className="rounded-sm border border-accent bg-accent-tint p-2 text-xs text-fg-primary font-medium">Full</div>
              <div className="rounded-sm border border-border-default bg-surface p-2 text-xs text-fg-muted">Lightweight</div>
            </div>
          </section>
        </Card>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Layout helpers                                                     */
/* ------------------------------------------------------------------ */

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-fg-muted">
      <Layout size={14} />
      {children}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Root export                                                        */
/* ------------------------------------------------------------------ */

export function VmSelectionPrototype() {
  const [surface, setSurface] = useState<SurfaceId>('project-settings');
  const [providerId, setProviderId] = useState<ProviderId>('hetzner');
  const [locationId, setLocationId] = useState('fsn1');
  const [sizeId, setSizeId] = useState<SizeId>('medium');

  const provider = useMemo(() => getProvider(providerId), [providerId]);

  const commonProps = {
    provider,
    sizeId,
    locationId,
    onSize: setSizeId,
    onProvider: setProviderId,
    onLocation: setLocationId,
  };

  return (
    <main className="min-h-screen bg-app text-fg-primary">
      <div className="mx-auto grid w-full max-w-6xl gap-5 px-4 py-5 sm:px-6 lg:px-8">
        <header className="grid gap-2">
          <div className="flex flex-wrap items-center gap-2 text-sm text-fg-muted">
            <Server size={16} />
            VM selection prototype
          </div>
          <h1 className="m-0 text-2xl font-semibold text-fg-primary sm:text-3xl">
            Standardized VM display across all surfaces
          </h1>
          <p className="m-0 max-w-3xl text-sm leading-6 text-fg-muted">
            Every location where users see or select a VM size now shows exact server type, vCPU, RAM, disk,
            and price from the provider catalog. No more vague &quot;Small / Medium / Large&quot; labels
            without specs.
          </p>
        </header>

        <SurfaceTabs selected={surface} onChange={setSurface} />

        {surface === 'project-settings' && <ProjectSettingsSurface {...commonProps} />}
        {surface === 'create-node' && <CreateNodeSurface {...commonProps} />}
        {surface === 'create-workspace' && <CreateWorkspaceSurface {...commonProps} />}
        {surface === 'task-submit' && <TaskSubmitSurface provider={provider} sizeId={sizeId} onSize={setSizeId} />}
        {surface === 'node-card' && <NodeCardSurface provider={provider} sizeId={sizeId} locationId={locationId} />}
        {surface === 'settings-drawer' && <SettingsDrawerSurface {...commonProps} />}

        <Card className="grid gap-3 p-4" variant="glass">
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 shrink-0 text-warning" size={18} />
            <div className="grid gap-1">
              <h2 className="m-0 text-base font-semibold text-fg-primary">Consistency principle</h2>
              <p className="m-0 text-sm leading-6 text-fg-muted">
                Every surface uses the same SizeCard component showing server type, vCPU, RAM, and price.
                The current app shows inconsistent labels: &quot;2-3 vCPUs, 4 GB RAM&quot; in some places,
                &quot;2 vCPUs, 4 GB RAM &mdash; &euro;3.99/mo&quot; in others, and bare &quot;Small / Medium /
                Large&quot; dropdowns with no specs at all in the task submit form.
              </p>
            </div>
          </div>
        </Card>
      </div>
    </main>
  );
}
