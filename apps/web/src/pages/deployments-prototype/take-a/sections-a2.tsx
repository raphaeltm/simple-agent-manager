/**
 * PROTOTYPE Take A detail sections, bottom half: settings, addresses, saved data,
 * behind the scenes, pause or delete.
 */
import { Button } from '@simple-agent-manager/ui';
import { HardDrive, Lock, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';

import { ModelToggleSwitch } from '../../../components/agent-models/ModelToggleSwitch';
import { objectRecord } from '../../../components/deployments/deployment-status';
import type {
  DeploymentCustomDomain,
  DeploymentEnvironment,
  DeploymentEnvironmentConfigVar,
  DeploymentPublicRoute,
  DeploymentVolume,
} from '../../../lib/api';
import { CopyButton, Disclosure, KeyValues, Panel, SectionTitle } from '../../automation/ui';
import { useContainers, useEnvironmentActions, useMetrics } from '../data';
import { ago, domainState } from '../model';
import { AddressLine, TonePill } from '../shared';

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function SettingRow({
  row,
  busy,
  onRemove,
}: {
  row: DeploymentEnvironmentConfigVar;
  busy: boolean;
  onRemove: () => void;
}) {
  return (
    <li className="grid min-h-14 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 border-0 border-b border-solid border-border-default px-4 py-2 last:border-b-0 sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)_auto]">
      <span className="min-w-0 break-all font-mono text-[13px] font-semibold text-fg-primary">{row.key}</span>
      {row.isSecret ? (
        <span className="col-start-1 inline-flex items-center gap-1 text-[13px] text-fg-muted sm:col-start-2 sm:row-start-1">
          <Lock size={12} aria-hidden /> Secret, hidden
        </span>
      ) : (
        <span className="col-start-1 min-w-0 break-all text-[13px] text-fg-muted sm:col-start-2 sm:row-start-1">
          {row.value || '(empty)'}
        </span>
      )}
      <button
        type="button"
        aria-label={`Remove ${row.key}`}
        disabled={busy}
        onClick={onRemove}
        className="col-start-2 row-span-2 row-start-1 inline-flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-md border-0 bg-transparent text-fg-muted hover:bg-danger-tint hover:text-danger-fg sm:col-start-3 sm:row-span-1"
      >
        <Trash2 size={16} aria-hidden />
      </button>
    </li>
  );
}

export function AppSettings({
  projectId,
  envId,
  rows,
}: {
  projectId: string;
  envId: string;
  rows: DeploymentEnvironmentConfigVar[];
}) {
  const actions = useEnvironmentActions(projectId, envId);
  const [adding, setAdding] = useState(false);
  const [key, setKey] = useState('');
  const [value, setValue] = useState('');
  const [secret, setSecret] = useState(false);
  const keyOk = KEY_RE.test(key.trim());
  return (
    <section className="flex flex-col gap-3" aria-label="Settings your app reads">
      <SectionTitle
        title="Settings your app reads"
        hint="Your Compose file reads these as ${NAME}. Changes apply on the next deploy."
        action={
          !adding ? (
            <Button variant="secondary" onClick={() => setAdding(true)} className="shrink-0">
              <Plus size={16} aria-hidden /> Add
            </Button>
          ) : undefined
        }
      />
      <Panel className="overflow-hidden">
        {adding && (
          <form
            className="flex flex-col gap-3 border-0 border-b border-solid border-border-default p-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (!keyOk) return;
              actions.saveSetting.mutate(
                { key: key.trim(), value, isSecret: secret },
                {
                  onSuccess: () => {
                    setAdding(false);
                    setKey('');
                    setValue('');
                    setSecret(false);
                  },
                }
              );
            }}
          >
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <input
                value={key}
                onChange={(event) => setKey(event.currentTarget.value.toUpperCase())}
                placeholder="NAME"
                aria-label="Name"
                spellCheck={false}
                className="min-h-11 rounded-md border border-border-default bg-surface px-3 font-mono text-[14px] text-fg-primary"
              />
              <input
                value={value}
                onChange={(event) => setValue(event.currentTarget.value)}
                placeholder="Value"
                aria-label="Value"
                type={secret ? 'password' : 'text'}
                className="min-h-11 rounded-md border border-border-default bg-surface px-3 text-[14px] text-fg-primary"
              />
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="flex min-w-0 flex-col">
                <span className="text-sm font-semibold text-fg-primary">Keep it secret</span>
                <span className="text-[13px] text-fg-muted">Hidden after saving, and never sent to builds.</span>
              </span>
              <ModelToggleSwitch checked={secret} label="Keep it secret" onChange={() => setSecret((v) => !v)} />
            </div>
            <div className="flex flex-wrap justify-end gap-3">
              <Button type="button" variant="ghost" onClick={() => setAdding(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={!keyOk} loading={actions.saveSetting.isPending}>
                Save setting
              </Button>
            </div>
          </form>
        )}
        {rows.length === 0 && !adding ? (
          <p className="m-0 px-4 py-5 text-sm text-fg-muted">
            No settings yet. Agents add what the app needs when they deploy, and you can add your own.
          </p>
        ) : (
          <ul className="m-0 list-none p-0">
            {rows.map((row) => (
              <SettingRow
                key={row.key}
                row={row}
                busy={actions.removeSetting.isPending}
                onRemove={() => {
                  if (window.confirm(`Remove ${row.key}? The app keeps using it until the next deploy.`))
                    actions.removeSetting.mutate(row.key);
                }}
              />
            ))}
          </ul>
        )}
      </Panel>
    </section>
  );
}

/**
 * Addresses grouped by the part of the app they reach. A custom domain leads; the address
 * SAM made is shown small underneath as "also at". Pills only for domains that need you.
 */
export function Addresses({
  env,
  answering,
  routes,
  domains,
  onAddDomain,
}: {
  env: DeploymentEnvironment;
  answering: boolean;
  routes: DeploymentPublicRoute[];
  domains: DeploymentCustomDomain[];
  onAddDomain: () => void;
}) {
  const reaches = (domain: DeploymentCustomDomain, route: DeploymentPublicRoute) =>
    domain.service === route.service && domain.port === route.port;
  const orphans = domains.filter((domain) => !routes.some((route) => reaches(domain, route)));
  const paused = env.status === 'stopped';
  return (
    <section id="addresses" className="flex flex-col gap-3" aria-label="Addresses">
      <SectionTitle
        title="Addresses"
        hint={paused ? 'Kept while paused. They answer again when you start the app.' : 'Where people reach this app.'}
        action={
          routes.length > 0 ? (
            <Button variant="secondary" onClick={onAddDomain} className="shrink-0">
              <Plus size={16} aria-hidden /> Your domain
            </Button>
          ) : undefined
        }
      />
      <Panel className="overflow-hidden">
        <ul className="m-0 list-none p-0">
          {routes.map((route) => {
            const own = domains.filter((domain) => reaches(domain, route));
            return (
              <li
                key={route.id}
                className="flex flex-col border-0 border-b border-solid border-border-default px-4 py-3 last:border-b-0"
              >
                <span className="text-[12px] font-semibold uppercase tracking-wide text-fg-muted">
                  {route.service}
                </span>
                {own.map((domain) => {
                  const state = domainState(domain);
                  return (
                    <span key={domain.id} className="flex flex-wrap items-center gap-x-2">
                      <AddressLine hostname={domain.hostname} answering={answering && state.tone === 'success'} />
                      {state.tone !== 'success' && <TonePill tone={state.tone} label={state.label} />}
                    </span>
                  );
                })}
                {own.length > 0 ? (
                  <span className="flex min-w-0 items-center gap-1 text-[13px] text-fg-muted">
                    <span className="shrink-0">also at</span>
                    <AddressLine hostname={route.hostname} size="sm" answering={answering} />
                  </span>
                ) : (
                  <AddressLine hostname={route.hostname} answering={answering} />
                )}
              </li>
            );
          })}
          {orphans.map((domain) => (
            <li
              key={domain.id}
              className="flex flex-col border-0 border-b border-solid border-border-default px-4 py-3 last:border-b-0"
            >
              <span className="text-[12px] font-semibold uppercase tracking-wide text-fg-muted">
                {domain.service} (no longer in the app)
              </span>
              <span className="flex flex-wrap items-center gap-x-2">
                <AddressLine hostname={domain.hostname} answering={false} />
                <TonePill tone="warning" label={domainState(domain).label} />
              </span>
            </li>
          ))}
        </ul>
        {routes.length === 0 && domains.length === 0 && (
          <p className="m-0 px-4 py-5 text-sm text-fg-muted">
            No addresses yet. The first deploy creates one for each part of the app that serves web traffic.
          </p>
        )}
      </Panel>
    </section>
  );
}

export function SavedData({ volumes }: { volumes: DeploymentVolume[] }) {
  if (volumes.length === 0) return null;
  const total = volumes.reduce((sum, volume) => sum + volume.sizeGb, 0);
  return (
    <section className="flex flex-col gap-3" aria-label="Saved data">
      <SectionTitle
        title="Saved data"
        hint={`${volumes.length} ${volumes.length === 1 ? 'disk' : 'disks'}, ${total} GB. Kept when you pause; deleted only with the environment.`}
      />
      <Panel className="overflow-hidden">
        <ul className="m-0 list-none p-0">
          {volumes.map((volume) => (
            <li
              key={volume.id}
              className="flex min-h-14 items-center gap-3 border-0 border-b border-solid border-border-default px-4 py-2 last:border-b-0"
            >
              <HardDrive size={18} aria-hidden className="shrink-0 text-fg-muted" />
              <span className="min-w-0 flex-1 break-all text-[15px] font-semibold text-fg-primary">
                {volume.name}
              </span>
              <span className="shrink-0 text-[13px] text-fg-muted">
                {volume.sizeGb} GB · {volume.attachedServerId ? 'in use' : 'stored'}
              </span>
            </li>
          ))}
        </ul>
      </Panel>
    </section>
  );
}

function Meter({ label, percent }: { label: string; percent: number | null }) {
  const value = percent === null ? null : Math.max(0, Math.min(100, percent));
  const color =
    value !== null && value >= 85
      ? 'var(--sam-color-danger-fg)'
      : value !== null && value >= 70
        ? 'var(--sam-color-warning-fg)'
        : 'var(--sam-color-success-fg)';
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span className="flex justify-between text-[13px]">
        <span className="text-fg-muted">{label}</span>
        <span className="font-semibold tabular-nums text-fg-primary">
          {value === null ? '–' : `${Math.round(value)}%`}
        </span>
      </span>
      <span className="h-1.5 overflow-hidden rounded-full bg-surface-hover">
        <span className="block h-full rounded-full" style={{ width: `${value ?? 0}%`, background: color }} />
      </span>
    </div>
  );
}

const SIGNAL_LABELS: Array<[string, string]> = [
  ['appHealth', 'App health check'],
  ['nodeHealth', 'Server check-ins'],
  ['routeCertState', 'HTTPS certificate'],
  ['diskPressure', 'Disk space'],
  ['configDrift', 'Settings since last deploy'],
  ['providerManageability', 'Cloud provider control'],
];

export function BehindTheScenes({
  projectId,
  env,
  volumes,
  open,
  onToggle,
}: {
  projectId: string;
  env: DeploymentEnvironment;
  volumes: DeploymentVolume[];
  open: boolean;
  onToggle: (open: boolean) => void;
}) {
  const running = env.node?.status === 'running';
  const metrics = useMetrics(projectId, env.id, open && running);
  const containers = useContainers(projectId, env.id, open && running);
  const info = metrics.data?.systemInfo;
  const fallback = metrics.data?.fallbackMetrics;
  const signals = objectRecord(env.observedDeployment.deployStatus) ?? {};
  const node = env.node;
  return (
    <section id="behind-the-scenes" aria-label="Behind the scenes">
      <Disclosure
        title="Behind the scenes"
        hint="The server, its containers, raw health signals and IDs."
        defaultOpen={open}
        onToggle={onToggle}
      >
        {node ? (
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <Link to={`/nodes/${node.id}`} className="break-all text-[15px] font-semibold text-accent no-underline hover:underline">
                {node.name}
              </Link>
              <span className="text-[13px] text-fg-muted">checked in {ago(node.lastHeartbeatAt)}</span>
            </div>
            <span className="text-[13px] text-fg-muted">
              {[node.cloudProvider, node.vmLocation, node.providerInstanceType ?? node.vmSize]
                .filter(Boolean)
                .join(' · ')}
            </span>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Meter label="CPU" percent={info ? (info.cpu.loadAvg1 / Math.max(1, info.cpu.numCpu)) * 100 : (fallback?.cpuLoadAvg1 ?? null)} />
              <Meter label="Memory" percent={info?.memory.usedPercent ?? fallback?.memoryPercent ?? null} />
              <Meter label="Disk" percent={info?.disk.usedPercent ?? fallback?.diskPercent ?? null} />
            </div>
          </div>
        ) : (
          <p className="m-0 text-sm text-fg-muted">No server right now. One is created when the app starts.</p>
        )}
        {(containers.data?.containers.length ?? 0) > 0 && (
          <div className="flex flex-col gap-2">
            <span className="text-[13px] font-semibold text-fg-primary">Containers</span>
            <ul className="m-0 flex list-none flex-col gap-1 p-0">
              {containers.data?.containers.map((container) => (
                <li key={container.name} className="flex flex-wrap items-baseline justify-between gap-2 text-[13px]">
                  <span className="break-all font-mono text-fg-primary">{container.name}</span>
                  <span className="text-fg-muted">{container.status ?? container.state}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        <KeyValues
          rows={[
            ...SIGNAL_LABELS.filter(([key]) => typeof signals[key] === 'string').map(
              ([key, label]) => [label, String(signals[key])] as [string, string]
            ),
            ['Environment ID', <span key="id" className="inline-flex items-center gap-1"><span className="break-all font-mono">{env.id}</span><CopyButton label="environment ID" value={env.id} /></span>],
            ...volumes.map(
              (volume) =>
                [`Disk ${volume.name}`, `${volume.providerName} ${volume.providerVolumeId}${volume.linuxDevice ? ` · ${volume.linuxDevice}` : ''}`] as [string, string]
            ),
          ]}
        />
      </Disclosure>
    </section>
  );
}

export function PauseOrDelete({
  env,
  siblings,
  onPause,
  onStart,
  onDelete,
}: {
  env: DeploymentEnvironment;
  siblings: number;
  onPause: () => void;
  onStart: () => void;
  onDelete: () => void;
}) {
  const paused = env.status === 'stopped';
  const changing = env.status === 'starting' || env.status === 'stopping';
  return (
    <section className="flex flex-col gap-3" aria-label="Pause or delete">
      <SectionTitle title={paused ? 'Start or delete' : 'Pause or delete'} />
      <Panel className="overflow-hidden">
        <div className="flex flex-col gap-3 border-0 border-b border-solid border-border-default p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="text-[15px] font-semibold text-fg-primary">{paused ? 'Start again' : 'Pause'}</span>
            <span className="text-[13px] text-fg-muted">
              {paused
                ? 'Brings back the last version with its data. Takes a few minutes.'
                : siblings > 1
                  ? 'Stops the app. Settings, domains and data are kept.'
                  : 'Stops the app and its server, so it stops costing money. Everything else is kept.'}
            </span>
          </div>
          <Button variant="secondary" className="shrink-0" disabled={changing} onClick={paused ? onStart : onPause}>
            {paused ? 'Start' : 'Pause'}
          </Button>
        </div>
        <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="text-[15px] font-semibold text-fg-primary">Delete this environment</span>
            <span className="text-[13px] text-fg-muted">Removes the app, its domains and its saved data. Can't be undone.</span>
          </div>
          <button
            type="button"
            disabled={changing}
            onClick={onDelete}
            className="inline-flex min-h-11 shrink-0 cursor-pointer items-center justify-center rounded-md border border-solid border-[color-mix(in_srgb,var(--sam-color-danger-fg)_45%,transparent)] bg-transparent px-4 text-[0.95rem] font-semibold text-danger-fg hover:bg-danger-tint disabled:cursor-not-allowed disabled:opacity-50"
          >
            Delete…
          </button>
        </div>
      </Panel>
    </section>
  );
}
