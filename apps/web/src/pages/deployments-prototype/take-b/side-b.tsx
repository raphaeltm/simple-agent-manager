/**
 * PROTOTYPE Take B side panel: health as a checklist in plain words, and settings as a
 * short list of rows that each open one focused sheet. The sheets reuse Take A's sections,
 * so both takes edit through the same components.
 */
import type { AgentProfile } from '@simple-agent-manager/shared';
import { Dialog } from '@simple-agent-manager/ui';
import { Check, ChevronRight, CircleAlert, HardDrive, KeyRound, Globe, Server, Users, X } from 'lucide-react';
import type { ReactNode } from 'react';

import { objectRecord } from '../../../components/deployments/deployment-status';
import type {
  DeploymentCustomDomain,
  DeploymentEnvironment,
  DeploymentEnvironmentConfigVar,
  DeploymentPublicRoute,
  DeploymentVolume,
} from '../../../lib/api';
import { Panel } from '../../automation/ui';
import { agentAccess, ago, since, type Tone, TONE_COLOR, tint } from '../model';
import { Addresses } from '../sections/addresses';
import { AppSettings } from '../sections/app-settings';
import { BehindTheScenes } from '../sections/behind';
import { SavedData } from '../sections/saved-data';
import { WhoCanDeploy } from '../sections/who-can-deploy';

interface HealthCheck {
  label: string;
  detail: string;
  tone: Tone;
}

function pct(value: unknown): string {
  const n = Number(value);
  return Number.isFinite(n) ? `${Math.round(n)}%` : '';
}

export function healthChecks(env: DeploymentEnvironment): HealthCheck[] {
  const status = objectRecord(env.observedDeployment.deployStatus) ?? {};
  const disk = objectRecord(objectRecord(env.observedDeployment.diskTelemetry)?.rootDisk);
  const node = (status.nodeHealth as string | undefined) ?? env.node?.healthStatus;
  const checks: HealthCheck[] = [];
  const add = (label: string, ok: boolean | null, good: string, bad: string, badTone: Tone = 'danger') =>
    checks.push(
      ok === null
        ? { label, detail: 'Not reported yet', tone: 'muted' }
        : { label, detail: ok ? good : bad, tone: ok ? 'success' : badTone }
    );
  const app = status.appHealth as string | undefined;
  add('Your app', app ? app === 'healthy' : null, 'Answers its health check', 'Fails its health check');
  const cert = status.routeCertState as string | undefined;
  add(
    'HTTPS',
    cert ? cert === 'issued' : null,
    'Certificate is valid',
    cert === 'pending' ? 'Certificate on its way' : 'Certificate failed',
    cert === 'pending' ? 'warning' : 'danger'
  );
  add(
    'Server',
    node ? node === 'healthy' : null,
    `Checked in ${ago(env.node?.lastHeartbeatAt)}`,
    node === 'stale' ? `No check-in for ${since(env.node?.lastHeartbeatAt)}` : 'Short on memory or CPU'
  );
  const pressure = status.diskPressure as string | undefined;
  add(
    'Disk',
    pressure ? pressure === 'normal' : null,
    `${pct(disk?.usedPercent)} used`.trim(),
    `${pct(disk?.usedPercent)} used, almost full`.trim(),
    pressure === 'critical' ? 'danger' : 'warning'
  );
  const drift = status.configDrift as string | undefined;
  add('Settings', drift ? drift !== 'drifted' : null, 'Match the last deploy', 'Changed since the last deploy', 'warning');
  // A silent server means every other reading is as old as its last check-in: say so
  // instead of showing stale green ticks.
  if (node === 'stale') {
    return checks.map((check) =>
      check.label === 'Server' || check.tone !== 'success'
        ? check
        : { ...check, tone: 'muted' as const, detail: `Last known: ${check.detail.toLowerCase()}` }
    );
  }
  return checks;
}

const CHECK_ICON: Record<Tone, ReactNode> = {
  success: <Check size={13} aria-hidden />,
  info: <Check size={13} aria-hidden />,
  warning: <CircleAlert size={13} aria-hidden />,
  danger: <X size={13} aria-hidden />,
  muted: <span aria-hidden className="h-1 w-1 rounded-full bg-current" />,
};

export function HealthList({ env }: { env: DeploymentEnvironment }) {
  if (env.status === 'stopped') {
    return <p className="m-0 text-sm text-fg-muted">Paused: nothing to check until it starts again.</p>;
  }
  if (!env.latestRelease) {
    return <p className="m-0 text-sm text-fg-muted">Nothing to check until the first deploy.</p>;
  }
  return (
    <ul className="m-0 flex list-none flex-col gap-2.5 p-0">
      {healthChecks(env).map((check) => {
        const color = TONE_COLOR[check.tone];
        return (
          <li key={check.label} className="flex items-center gap-3">
            <span
              className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full"
              style={{ background: tint(color, 18), color }}
            >
              {CHECK_ICON[check.tone]}
            </span>
            <span className="flex min-w-0 flex-1 flex-wrap items-baseline justify-between gap-x-3">
              <span className="text-sm font-semibold text-fg-primary">{check.label}</span>
              <span className="text-[13px]" style={{ color: check.tone === 'success' ? undefined : color }}>
                <span className={check.tone === 'success' ? 'text-fg-muted' : ''}>{check.detail}</span>
              </span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

export type SheetKey = 'access' | 'settings' | 'domains' | 'data' | 'server';

function Row({
  icon,
  title,
  value,
  onOpen,
}: {
  icon: ReactNode;
  title: string;
  value: string;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group flex min-h-14 w-full cursor-pointer items-center gap-3 border-0 border-b border-solid border-border-default bg-transparent px-4 py-2 text-left last:border-b-0 hover:bg-surface-hover"
    >
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-surface-hover text-fg-muted">
        {icon}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-sm font-semibold text-fg-primary">{title}</span>
        <span className="min-w-0 truncate text-[13px] text-fg-muted">{value}</span>
      </span>
      <ChevronRight size={16} aria-hidden className="shrink-0 text-fg-muted transition-transform group-hover:translate-x-0.5" />
    </button>
  );
}

export function SettingsRows({
  env,
  profiles,
  config,
  domains,
  volumes,
  onOpen,
}: {
  env: DeploymentEnvironment;
  profiles: AgentProfile[];
  config: DeploymentEnvironmentConfigVar[];
  domains: DeploymentCustomDomain[];
  volumes: DeploymentVolume[];
  onOpen: (key: SheetKey) => void;
}) {
  const access = agentAccess(env, profiles);
  const secrets = config.filter((row) => row.isSecret).length;
  const size = volumes.reduce((sum, volume) => sum + volume.sizeGb, 0);
  return (
    <Panel className="overflow-hidden">
      <Row
        icon={<Users size={16} />}
        title="Who can deploy"
        value={access.mode === 'some' ? access.names.join(', ') : access.sentence}
        onOpen={() => onOpen('access')}
      />
      <Row
        icon={<KeyRound size={16} />}
        title="Settings and secrets"
        value={config.length === 0 ? 'None yet' : `${config.length - secrets} settings, ${secrets} secrets`}
        onOpen={() => onOpen('settings')}
      />
      <Row
        icon={<Globe size={16} />}
        title="Domains"
        value={domains.length === 0 ? 'Only the address SAM made' : domains.map((domain) => domain.hostname).join(', ')}
        onOpen={() => onOpen('domains')}
      />
      <Row
        icon={<HardDrive size={16} />}
        title="Saved data"
        value={volumes.length === 0 ? 'None' : `${volumes.length} ${volumes.length === 1 ? 'disk' : 'disks'}, ${size} GB`}
        onOpen={() => onOpen('data')}
      />
      <Row
        icon={<Server size={16} />}
        title="Server"
        value={env.node ? [env.node.name, env.node.cloudProvider, env.node.vmLocation].filter(Boolean).join(' · ') : 'None while not running'}
        onOpen={() => onOpen('server')}
      />
    </Panel>
  );
}

export function SettingsSheet({
  sheet,
  projectId,
  env,
  profiles,
  config,
  routes,
  domains,
  volumes,
  answering,
  onAddDomain,
  onClose,
}: {
  sheet: SheetKey | null;
  projectId: string;
  env: DeploymentEnvironment;
  profiles: AgentProfile[];
  config: DeploymentEnvironmentConfigVar[];
  routes: DeploymentPublicRoute[];
  domains: DeploymentCustomDomain[];
  volumes: DeploymentVolume[];
  answering: boolean;
  onAddDomain: () => void;
  onClose: () => void;
}) {
  return (
    <Dialog isOpen={sheet !== null} onClose={onClose} maxWidth="lg" aria-label="Environment settings">
      <div className="flex flex-col gap-4">
        {sheet === 'access' && <WhoCanDeploy projectId={projectId} env={env} profiles={profiles} />}
        {sheet === 'settings' && <AppSettings projectId={projectId} envId={env.id} rows={config} />}
        {sheet === 'domains' && (
          <Addresses
            projectId={projectId}
            env={env}
            answering={answering}
            routes={routes}
            domains={domains}
            onAddDomain={onAddDomain}
          />
        )}
        {sheet === 'data' && <SavedData projectId={projectId} env={env} volumes={volumes} />}
        {sheet === 'server' && (
          <BehindTheScenes projectId={projectId} env={env} volumes={volumes} open onToggle={() => undefined} />
        )}
      </div>
    </Dialog>
  );
}
