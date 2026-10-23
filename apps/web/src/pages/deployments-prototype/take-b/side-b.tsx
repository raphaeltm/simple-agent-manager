/**
 * PROTOTYPE Take B side panel: health as a checklist in plain words, and settings as a
 * short list of rows that each open one focused sheet. The sheets reuse Take A's sections,
 * so both takes edit through the same components.
 */
import type { AgentProfile } from '@simple-agent-manager/shared';
import { Dialog } from '@simple-agent-manager/ui';
import { Check, ChevronRight, CircleAlert, Globe, HardDrive, KeyRound, Server, Users, X } from 'lucide-react';
import type { ReactNode } from 'react';

import { objectRecord, serviceRecords } from '../../../components/deployments/deployment-status';
import type {
  DeploymentCustomDomain,
  DeploymentEnvironment,
  DeploymentEnvironmentConfigVar,
  DeploymentPublicRoute,
  DeploymentVolume,
} from '../../../lib/api';
import { Panel } from '../../automation/ui';
import { useMetrics } from '../data';
import { SheetHeader } from '../dialogs';
import {
  agentAccess,
  ago,
  domainState,
  liveVersionOf,
  releaseOutcome,
  serverSilent,
  since,
  tint,
  type Tone,
  TONE_COLOR,
} from '../model';
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

/**
 * Health in words, from signals production sends today: per-service state, the version
 * that runs, the server's heartbeat, custom domains, and live disk use from the metrics
 * route. HTTPS joins the list only when an agent reports the six-dimension status.
 */
export function healthChecks(
  env: DeploymentEnvironment,
  domains: DeploymentCustomDomain[],
  diskPercent: number | null
): HealthCheck[] {
  const checks: HealthCheck[] = [];
  const live = liveVersionOf(env);
  const release = env.latestRelease;
  const services = serviceRecords(env.observedDeployment.services);

  if (services.length > 0 && live) {
    const down = services.filter((service) => service.status !== 'running' || service.health === 'unhealthy');
    checks.push(
      down.length === 0
        ? { label: 'Your app', detail: `All ${services.length} parts running`, tone: 'success' }
        : { label: 'Your app', detail: `${down.length} of ${services.length} parts not running`, tone: 'danger' }
    );
  }
  if (release) {
    const outcome = releaseOutcome(release, env);
    checks.push(
      live === release.version
        ? { label: 'Version', detail: `Running the newest, v${live}`, tone: 'success' }
        : outcome.label === 'Deploying'
          ? { label: 'Version', detail: `v${release.version} is starting`, tone: 'info' }
          : live
            ? { label: 'Version', detail: `v${release.version} didn't start; v${live} runs`, tone: 'warning' }
            : { label: 'Version', detail: 'Nothing running', tone: 'danger' }
    );
  }
  const silent = serverSilent(env);
  if (env.node) {
    const creating = env.node.status === 'pending' || env.node.status === 'creating';
    checks.push(
      creating
        ? { label: 'Server', detail: 'Being created', tone: 'info' }
        : silent
          ? { label: 'Server', detail: `No check-in for ${since(env.node.lastHeartbeatAt)}`, tone: 'danger' }
          : { label: 'Server', detail: `Checked in ${ago(env.node.lastHeartbeatAt)}`, tone: 'success' }
    );
  }
  const certState = objectRecord(env.observedDeployment.deployStatus)?.routeCertState;
  if (typeof certState === 'string' && certState !== 'unknown') {
    checks.push(
      certState === 'healthy'
        ? { label: 'HTTPS', detail: 'Certificates are valid', tone: 'success' }
        : { label: 'HTTPS', detail: certState === 'pending' ? 'Certificate on its way' : 'Certificate problem', tone: certState === 'pending' ? 'info' : 'danger' }
    );
  }
  if (domains.length > 0) {
    const waiting = domains.filter((domain) => domainState(domain).tone !== 'success' && domainState(domain).tone !== 'muted');
    checks.push(
      waiting.length === 0
        ? { label: 'Domains', detail: `${domains.length === 1 ? 'Your domain works' : `All ${domains.length} work`}`, tone: 'success' }
        : { label: 'Domains', detail: `${waiting.length} ${waiting.length === 1 ? 'needs' : 'need'} a DNS fix`, tone: 'warning' }
    );
  }
  if (diskPercent !== null) {
    const used = Math.round(diskPercent);
    checks.push({
      label: 'Disk',
      detail: used >= 85 ? `${used}% used, nearly full` : `${used}% used`,
      tone: used >= 95 ? 'danger' : used >= 85 ? 'warning' : 'success',
    });
  }
  // A silent server means every other reading is as old as its last check-in: say so
  // instead of showing stale green ticks.
  if (silent) {
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

export function HealthList({
  projectId,
  env,
  domains,
}: {
  projectId: string;
  env: DeploymentEnvironment;
  domains: DeploymentCustomDomain[];
}) {
  const metrics = useMetrics(projectId, env.id, env.node?.status === 'running' && env.node.healthStatus !== 'stale');
  const diskPercent = metrics.data?.systemInfo?.disk.usedPercent ?? metrics.data?.fallbackMetrics?.diskPercent ?? null;
  if (env.status === 'stopped') {
    return <p className="m-0 text-sm text-fg-muted">Paused: nothing to check until it starts again.</p>;
  }
  if (!env.latestRelease) {
    return <p className="m-0 text-sm text-fg-muted">Nothing to check until the first deploy.</p>;
  }
  return (
    <ul className="m-0 flex list-none flex-col gap-2.5 p-0">
      {healthChecks(env, domains, diskPercent).map((check) => {
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
              <span className="text-[13px]" style={{ color: check.tone === 'success' || check.tone === 'muted' ? undefined : color }}>
                <span className={check.tone === 'success' || check.tone === 'muted' ? 'text-fg-muted' : ''}>{check.detail}</span>
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
  choosingAccess,
  onChoosingChange,
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
  /** Opened from "Let agents deploy here": show the who-can-deploy choice straight away. */
  choosingAccess?: boolean;
  onChoosingChange: (choosing: boolean) => void;
  onAddDomain: () => void;
  onClose: () => void;
}) {
  return (
    <Dialog isOpen={sheet !== null} onClose={onClose} maxWidth="lg" aria-label="Environment settings">
      <div className="flex flex-col gap-4">
        <SheetHeader
          title={<span className="text-[13px] font-semibold uppercase tracking-wide text-fg-muted">Settings</span>}
          onClose={onClose}
        />
        {sheet === 'access' && (
          <WhoCanDeploy
            projectId={projectId}
            env={env}
            profiles={profiles}
            choosing={choosingAccess}
            onChoosingChange={onChoosingChange}
          />
        )}
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
