import { Card, Select, StatusBadge } from '@simple-agent-manager/ui';
import {
  AlertTriangle,
  CheckCircle2,
  Cpu,
  Database,
  HardDrive,
  MapPin,
  Server,
  SlidersHorizontal,
  UserRoundCog,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { useMemo, useState } from 'react';

type ProviderId = 'hetzner' | 'scaleway' | 'gcp';
type SizeId = 'small' | 'medium' | 'large';
type SurfaceId = 'project' | 'profile' | 'provision' | 'scheduler';

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
      {
        id: 'small',
        label: 'Small',
        type: 'cx23',
        price: '€3.99/mo',
        vcpu: 2,
        ramGb: 4,
        storageGb: 40,
      },
      {
        id: 'medium',
        label: 'Medium',
        type: 'cx33',
        price: '€7.49/mo',
        vcpu: 4,
        ramGb: 8,
        storageGb: 80,
      },
      {
        id: 'large',
        label: 'Large',
        type: 'cx43',
        price: '€14.49/mo',
        vcpu: 8,
        ramGb: 16,
        storageGb: 160,
      },
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
      {
        id: 'small',
        label: 'Small',
        type: 'DEV1-M',
        price: '~€0.024/hr',
        vcpu: 3,
        ramGb: 4,
        storageGb: 40,
      },
      {
        id: 'medium',
        label: 'Medium',
        type: 'DEV1-XL',
        price: '~€0.048/hr',
        vcpu: 4,
        ramGb: 12,
        storageGb: 80,
      },
      {
        id: 'large',
        label: 'Large',
        type: 'GP1-S',
        price: '~€0.084/hr',
        vcpu: 8,
        ramGb: 32,
        storageGb: 150,
      },
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
      {
        id: 'small',
        label: 'Small',
        type: 'e2-medium',
        price: '~$25/mo',
        vcpu: 1,
        ramGb: 4,
        storageGb: 50,
      },
      {
        id: 'medium',
        label: 'Medium',
        type: 'e2-standard-2',
        price: '~$49/mo',
        vcpu: 2,
        ramGb: 8,
        storageGb: 50,
      },
      {
        id: 'large',
        label: 'Large',
        type: 'e2-standard-4',
        price: '~$97/mo',
        vcpu: 4,
        ramGb: 16,
        storageGb: 50,
      },
    ],
  },
];

const surfaces: Array<{ id: SurfaceId; label: string; icon: ReactNode }> = [
  { id: 'project', label: 'Project defaults', icon: <SlidersHorizontal size={16} /> },
  { id: 'profile', label: 'Agent profile', icon: <UserRoundCog size={16} /> },
  { id: 'provision', label: 'Provisioning', icon: <Server size={16} /> },
  { id: 'scheduler', label: 'Scheduler', icon: <Cpu size={16} /> },
];

function firstItem<T>(items: T[], label: string): T {
  const item = items[0];
  if (!item) throw new Error(`VM selection prototype requires at least one ${label}`);
  return item;
}

function getProvider(id: ProviderId): ProviderOption {
  return providers.find((provider) => provider.id === id) ?? firstItem(providers, 'provider');
}

function getSize(provider: ProviderOption, id: SizeId): SizeOption {
  return provider.sizes.find((size) => size.id === id) ?? firstItem(provider.sizes, 'size');
}

function getLocation(provider: ProviderOption, id: string): LocationOption {
  return (
    provider.locations.find((location) => location.id === id) ??
    firstItem(provider.locations, 'location')
  );
}

function isProviderId(value: string): value is ProviderId {
  return providers.some((provider) => provider.id === value);
}

function isSizeId(provider: ProviderOption, value: string): value is SizeId {
  return provider.sizes.some((size) => size.id === value);
}

function SurfaceTabs({
  selected,
  onChange,
}: {
  selected: SurfaceId;
  onChange: (surface: SurfaceId) => void;
}) {
  return (
    <div className="flex gap-2 overflow-x-auto pb-1" aria-label="Prototype screens">
      {surfaces.map((surface) => (
        <button
          key={surface.id}
          type="button"
          aria-pressed={selected === surface.id}
          onClick={() => onChange(surface.id)}
          className={`inline-flex min-h-11 shrink-0 items-center gap-2 rounded-sm border px-3 py-2 text-sm font-medium transition ${
            selected === surface.id
              ? 'border-accent bg-accent-tint text-fg-primary'
              : 'border-border-default bg-surface text-fg-muted hover:text-fg-primary'
          }`}
        >
          {surface.icon}
          {surface.label}
        </button>
      ))}
    </div>
  );
}

function VmPicker({
  providerId,
  locationId,
  sizeId,
  onProvider,
  onLocation,
  onSize,
}: {
  providerId: ProviderId;
  locationId: string;
  sizeId: SizeId;
  onProvider: (provider: ProviderId) => void;
  onLocation: (location: string) => void;
  onSize: (size: SizeId) => void;
}) {
  const provider = getProvider(providerId);
  const size = getSize(provider, sizeId);

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
      <Card className="grid gap-4 p-4" variant="glass">
        <Field label="Provider" id="provider-select">
          <Select
            id="provider-select"
            value={providerId}
            onChange={(event) => {
              const next = event.currentTarget.value;
              if (!isProviderId(next)) return;
              const nextProvider = getProvider(next);
              onProvider(next);
              onLocation(firstItem(nextProvider.locations, 'location').id);
            }}
          >
            {providers.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="Region / datacenter" id="location-select">
          <Select
            id="location-select"
            value={locationId}
            onChange={(event) => onLocation(event.currentTarget.value)}
          >
            {provider.locations.map((location) => (
              <option key={location.id} value={location.id}>
                {location.label}, {location.country}
                {location.policy === 'blocked' ? ' - blocked by policy' : ''}
              </option>
            ))}
          </Select>
        </Field>

        <fieldset className="grid gap-2 border-0 p-0">
          <legend className="text-sm font-medium text-fg-muted">VM size</legend>
          <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-1 xl:grid-cols-3">
            {provider.sizes.map((option) => (
              <label
                key={option.id}
                htmlFor={`vm-size-${option.id}`}
                className={`min-h-[88px] rounded-sm border p-3 text-left transition ${
                  option.id === sizeId
                    ? 'border-accent bg-accent-tint'
                    : 'border-border-default bg-surface hover:border-accent/60'
                }`}
              >
                <input
                  id={`vm-size-${option.id}`}
                  className="sr-only"
                  type="radio"
                  name="vm-size"
                  checked={option.id === sizeId}
                  onChange={(event) => {
                    const next = event.currentTarget.value;
                    if (isSizeId(provider, next)) onSize(next);
                  }}
                  value={option.id}
                />
                <span className="block text-sm font-semibold text-fg-primary">{option.label}</span>
                <span className="mt-1 block text-xs text-fg-muted">{option.type}</span>
                <span className="mt-1 block text-xs text-fg-muted">{option.price}</span>
              </label>
            ))}
          </div>
        </fieldset>
      </Card>

      <SpecSummary provider={provider} location={getLocation(provider, locationId)} size={size} />
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

function SpecSummary({
  provider,
  location,
  size,
}: {
  provider: ProviderOption;
  location: LocationOption;
  size: SizeOption;
}) {
  const stats = [
    { label: 'vCPU', value: size.vcpu, icon: <Cpu size={18} /> },
    { label: 'RAM', value: `${size.ramGb} GB`, icon: <Database size={18} /> },
    { label: 'Disk', value: `${size.storageGb} GB`, icon: <HardDrive size={18} /> },
    { label: 'Price', value: size.price, icon: <CheckCircle2 size={18} /> },
  ];

  return (
    <Card className="grid gap-4 p-4" variant="glass">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-xs font-semibold uppercase text-fg-muted">Resolved selection</div>
          <h2 className="m-0 mt-1 text-xl font-semibold text-fg-primary">
            {provider.label} {size.type}
          </h2>
        </div>
        <StatusBadge status={location.policy === 'allowed' ? 'running' : 'error'} />
      </div>

      <div className="flex items-center gap-2 rounded-sm border border-border-default bg-inset px-3 py-2 text-sm text-fg-primary">
        <MapPin size={16} />
        <span>
          {location.label}, {location.country} ({location.id})
        </span>
      </div>

      <div className="grid grid-cols-2 gap-2">
        {stats.map((stat) => (
          <div key={stat.label} className="rounded-sm border border-border-default bg-surface p-3">
            <div className="flex items-center gap-2 text-xs text-fg-muted">
              {stat.icon}
              {stat.label}
            </div>
            <div className="mt-1 text-lg font-semibold text-fg-primary">{stat.value}</div>
          </div>
        ))}
      </div>

      <Note tone={location.policy === 'allowed' ? 'info' : 'warning'}>
        {location.policy === 'allowed'
          ? 'Provisioning must use this exact provider and region. Silent cross-region fallback is not allowed.'
          : 'This location is blocked by policy and cannot be selected for new work.'}
      </Note>
    </Card>
  );
}

function Note({ tone, children }: { tone: 'info' | 'warning'; children: ReactNode }) {
  const classes =
    tone === 'warning'
      ? 'border-warning/30 bg-warning-tint text-warning'
      : 'border-info/20 bg-info-tint text-info';

  return (
    <div className={`rounded-sm border px-4 py-3 text-sm leading-6 ${classes}`}>{children}</div>
  );
}

function SurfacePreview({
  surface,
  provider,
  location,
  size,
}: {
  surface: SurfaceId;
  provider: ProviderOption;
  location: LocationOption;
  size: SizeOption;
}) {
  if (surface === 'profile') {
    return (
      <PreviewShell title="Agent profile infrastructure" eyebrow="Profile override">
        <PreviewRow
          label="Runtime policy"
          value="Use profile-specific provider, region, and exact VM specs"
        />
        <PreviewRow
          label="Selected VM"
          value={`${provider.label} ${size.type} · ${size.vcpu} vCPU · ${size.ramGb} GB RAM`}
        />
        <PreviewRow label="Region" value={`${location.label}, ${location.country}`} />
      </PreviewShell>
    );
  }

  if (surface === 'provision') {
    return (
      <PreviewShell title="Create node / workspace" eyebrow="Provisioning confirmation">
        <PreviewRow label="Requested location" value={`${location.id} (${location.label})`} />
        <PreviewRow
          label="Fallback behavior"
          value="Fail clearly on no capacity; do not try another region silently"
        />
        <PreviewRow
          label="Estimated cost"
          value={`${size.price} before provider taxes or credits`}
        />
      </PreviewShell>
    );
  }

  if (surface === 'scheduler') {
    return (
      <PreviewShell title="Scheduler match" eyebrow="Capacity check">
        <PreviewRow
          label="Minimum requested"
          value={`${size.vcpu} vCPU and ${size.ramGb} GB RAM`}
        />
        <PreviewRow
          label="Eligible nodes"
          value="Same provider, same region, vCPU >= request, RAM >= request"
        />
        <PreviewRow
          label="Rejected nodes"
          value="Wrong region, smaller memory, blocked policy, stale health"
        />
      </PreviewShell>
    );
  }

  return (
    <PreviewShell title="Project VM defaults" eyebrow="Project settings">
      <PreviewRow label="Default provider" value={provider.label} />
      <PreviewRow label="Default region" value={`${location.label}, ${location.country}`} />
      <PreviewRow label="Default VM" value={`${size.label} (${size.type}) · ${size.price}`} />
    </PreviewShell>
  );
}

function PreviewShell({
  eyebrow,
  title,
  children,
}: {
  eyebrow: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <Card className="grid gap-3 p-4" variant="default">
      <div>
        <div className="text-xs font-semibold uppercase text-fg-muted">{eyebrow}</div>
        <h3 className="m-0 mt-1 text-lg font-semibold text-fg-primary">{title}</h3>
      </div>
      <div className="grid gap-2">{children}</div>
    </Card>
  );
}

function PreviewRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid gap-1 rounded-sm border border-border-default bg-inset p-3 sm:grid-cols-[11rem_1fr] sm:items-center">
      <span className="text-xs font-medium uppercase text-fg-muted">{label}</span>
      <span className="text-sm text-fg-primary">{value}</span>
    </div>
  );
}

export function VmSelectionPrototype() {
  const [surface, setSurface] = useState<SurfaceId>('project');
  const [providerId, setProviderId] = useState<ProviderId>('hetzner');
  const [locationId, setLocationId] = useState('fsn1');
  const [sizeId, setSizeId] = useState<SizeId>('large');

  const selection = useMemo(() => {
    const provider = getProvider(providerId);
    return {
      provider,
      location: getLocation(provider, locationId),
      size: getSize(provider, sizeId),
    };
  }, [locationId, providerId, sizeId]);

  return (
    <main className="min-h-screen bg-app text-fg-primary">
      <div className="mx-auto grid w-full max-w-6xl gap-5 px-4 py-5 sm:px-6 lg:px-8">
        <header className="grid gap-2">
          <div className="flex flex-wrap items-center gap-2 text-sm text-fg-muted">
            <Server size={16} />
            VM selection prototype
          </div>
          <h1 className="m-0 text-2xl font-semibold text-fg-primary sm:text-3xl">
            Exact provider, region, size, specs, and price
          </h1>
          <p className="m-0 max-w-3xl text-sm leading-6 text-fg-muted">
            This prototype treats the selected region as a contract. Capacity failures surface as
            explicit errors instead of quietly provisioning somewhere else.
          </p>
        </header>

        <SurfaceTabs selected={surface} onChange={setSurface} />

        <VmPicker
          providerId={providerId}
          locationId={locationId}
          sizeId={sizeId}
          onProvider={setProviderId}
          onLocation={setLocationId}
          onSize={setSizeId}
        />

        <SurfacePreview
          surface={surface}
          provider={selection.provider}
          location={selection.location}
          size={selection.size}
        />

        <Card className="grid gap-3 p-4" variant="glass">
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 shrink-0 text-warning" size={18} />
            <div className="grid gap-1">
              <h2 className="m-0 text-base font-semibold text-fg-primary">Implementation note</h2>
              <p className="m-0 text-sm leading-6 text-fg-muted">
                The production version should persist resolved VM snapshots on nodes and workspaces:
                requested region, actual region if provider-reported, server type, vCPU, RAM, disk,
                and estimated price at creation time.
              </p>
            </div>
          </div>
        </Card>
      </div>
    </main>
  );
}
