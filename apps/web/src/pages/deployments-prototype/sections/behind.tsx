/**
 * PROTOTYPE "Behind the scenes", used by both takes: the server, its containers, raw
 * health signals and IDs, collapsed by default.
 */
import { Button } from '@simple-agent-manager/ui';
import { useState } from 'react';
import { Link } from 'react-router';

import { objectRecord } from '../../../components/deployments/deployment-status';
import type { DeploymentEnvironment, DeploymentVolume } from '../../../lib/api';
import { CopyButton, Disclosure, KeyValues } from '../../automation/ui';
import { useContainers, useEnvironmentActions, useMetrics } from '../data';
import { ago } from '../model';

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
  const actions = useEnvironmentActions(projectId, env.id);
  // Detaching under a running app pulls its data away mid-write: ask once before doing it.
  const [confirmDetach, setConfirmDetach] = useState(false);
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
              <Meter label="CPU" percent={info ? (info.cpu.loadAvg1 / Math.max(1, info.cpu.numCpu)) * 100 : null} />
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
        {volumes.length > 0 && (
          <div className="flex flex-col gap-2">
            <span className="text-[13px] text-fg-muted">
              SAM attaches the disks when the app starts and detaches them when it pauses. Do it by hand only to
              recover from a stuck server.
            </span>
            {confirmDetach ? (
              <div role="alert" className="flex flex-col gap-3 rounded-lg bg-warning-tint p-3">
                <span className="text-[13px] font-medium text-warning-fg">
                  The app loses its saved data until the disks are attached again, and anything it is writing
                  right now may be lost. Pausing is the safe way to stop it.
                </span>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="danger"
                    loading={actions.detachDisks.isPending}
                    onClick={() => actions.detachDisks.mutate(undefined, { onSettled: () => setConfirmDetach(false) })}
                  >
                    Detach anyway
                  </Button>
                  <Button variant="ghost" onClick={() => setConfirmDetach(false)}>
                    Keep them attached
                  </Button>
                </div>
              </div>
            ) : (
              <div className="flex flex-wrap gap-2">
                <Button variant="secondary" loading={actions.attachDisks.isPending} disabled={!env.nodeId} onClick={() => actions.attachDisks.mutate()}>
                  Attach disks
                </Button>
                <Button variant="secondary" disabled={!env.nodeId} onClick={() => setConfirmDetach(true)}>
                  Detach disks…
                </Button>
              </div>
            )}
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

