/**
 * PROTOTYPE Take A, "Calm status page": one environment.
 *
 * One scroll instead of seven tabs, ordered by why people open the page:
 * 1. Is it up, and where is it? (status in words, the address, Open)
 * 2. If not, what do I do? (problems, each with its fix)
 * 3. What shipped, by which agent, from which chat?
 * 4. Who may ship here, what the app reads, where it answers, what data it keeps.
 * 5. Server internals, collapsed. Pause and Delete at the very bottom, with Delete
 *    behind a typed confirmation instead of a red button beside Stop.
 */
import { Button, buttonClassName } from '@simple-agent-manager/ui';
import { ChevronLeft, ExternalLink, ScrollText, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';

import { useToast } from '../../../hooks/useToast';
import type { DeploymentEnvironment } from '../../../lib/api';
import { Loading } from '../../automation/page';
import { Panel } from '../../automation/ui';
import { useProjectContext } from '../../ProjectContext';
import {
  useConfig,
  useDomains,
  useEnvironment,
  useEnvironmentActions,
  useProfiles,
  useReleases,
  useVolumes,
} from '../data';
import { AddDomainDialog, DeleteDialog, LogsDialog, PauseDialog } from '../dialogs';
import {
  agentAccess,
  ago,
  describeHealth,
  describeProblems,
  domainProblems,
  type Fix,
  type HealthInfo,
  isAnswering,
  lastGoodVersion,
  primaryAddress,
  profileNameOf,
  TONE_COLOR,
  tint,
} from '../model';
import { AddressLine, AgentAvatar, ChatLink, HealthMark, useAskAgent } from '../shared';
import { withTake } from '../take';
import { Column } from './column';
import { Addresses } from '../sections/addresses';
import { AppSettings } from '../sections/app-settings';
import { BehindTheScenes } from '../sections/behind';
import { SavedData } from '../sections/saved-data';
import { WhoCanDeploy } from '../sections/who-can-deploy';
import { PauseOrDelete } from './pause-or-delete';
import { ProblemList, RecentDeploys } from './sections-a';

/** The one action that matters most right now, as the page's only primary button. */
function HeroAction({
  info,
  hostname,
  agentsOn,
  onStart,
  onAsk,
  onAllowAgents,
}: {
  info: HealthInfo;
  hostname: string | null;
  agentsOn: boolean;
  onStart: () => void;
  onAsk: () => void;
  onAllowAgents: () => void;
}) {
  if (info.health === 'paused') return <Button onClick={onStart}>Start again</Button>;
  if (info.health === 'new' || info.health === 'down') {
    // Asking an agent is pointless while agents may not deploy here: offer the switch first.
    if (!agentsOn) return <Button onClick={onAllowAgents}>Let agents deploy here</Button>;
    return (
      <Button onClick={onAsk}>
        <Sparkles size={16} aria-hidden />
        {info.health === 'new' ? 'Ask an agent to deploy' : 'Ask an agent to fix it'}
      </Button>
    );
  }
  if (!hostname || !isAnswering(info.health)) return null;
  return (
    <a
      href={`https://${hostname}`}
      target="_blank"
      rel="noreferrer"
      className={`${buttonClassName({ variant: 'primary' })} no-underline`}
    >
      Open app <ExternalLink size={16} aria-hidden />
    </a>
  );
}

function Hero({
  env,
  info,
  hostname,
  extraAddresses,
  projectId,
  profileName,
  agentsOn,
  onLogs,
  onStart,
  onAsk,
  onAllowAgents,
}: {
  env: DeploymentEnvironment;
  info: HealthInfo;
  hostname: string | null;
  extraAddresses: number;
  projectId: string;
  profileName: string | null;
  agentsOn: boolean;
  onLogs: () => void;
  onStart: () => void;
  onAsk: () => void;
  onAllowAgents: () => void;
}) {
  const color = TONE_COLOR[info.tone];
  const release = env.latestRelease;
  const answering = isAnswering(info.health);
  const showLogs = Boolean(release) && env.status !== 'stopped';
  return (
    <Panel className="relative overflow-hidden p-5 sm:p-6" label={env.name}>
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-28"
        style={{ background: `linear-gradient(180deg, ${tint(color, 16)}, transparent)` }}
      />
      <div className="relative flex flex-col gap-4">
        <div className="flex items-start gap-3">
          <HealthMark info={info} size={48} />
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <h1 className="m-0 break-words text-[22px] font-bold leading-tight tracking-[-0.01em] text-fg-primary [overflow-wrap:anywhere] sm:text-[26px]">
              {env.name}
            </h1>
            <p className="m-0 text-[15px] text-fg-primary">
              <span className="font-semibold" style={{ color }}>
                {info.label}.
              </span>{' '}
              {info.sentence}
            </p>
          </div>
        </div>

        {hostname && (
          <div className="flex flex-col">
            <AddressLine hostname={hostname} size="lg" answering={answering} />
            {!answering && (
              <span className="text-[13px] text-fg-muted">
                {info.health === 'paused' ? 'Answers again when you start it.' : "Not answering right now."}
              </span>
            )}
            {extraAddresses > 0 && (
              <a
                href="#addresses"
                className="inline-flex min-h-9 w-fit items-center text-[13px] font-medium text-fg-muted no-underline hover:text-fg-primary"
              >
                +{extraAddresses} more {extraAddresses === 1 ? 'address' : 'addresses'}
              </a>
            )}
          </div>
        )}

        {release && (
          <div className="flex items-center gap-2.5 text-[13px] text-fg-muted">
            <AgentAvatar name={profileName ?? 'Someone'} size={28} />
            <span className="min-w-0">
              v{release.version} by{' '}
              <span className="font-semibold text-fg-primary">{profileName ?? 'someone'}</span>,{' '}
              {ago(release.createdAt)}
              {release.submittedBy?.taskId && (
                <>
                  {', from '}
                  <ChatLink projectId={projectId} taskId={release.submittedBy.taskId} />
                </>
              )}
            </span>
          </div>
        )}

        <div className="flex flex-wrap gap-3">
          <HeroAction
            info={info}
            hostname={hostname}
            agentsOn={agentsOn}
            onStart={onStart}
            onAsk={onAsk}
            onAllowAgents={onAllowAgents}
          />
          {showLogs && (
            <Button variant="secondary" onClick={onLogs}>
              <ScrollText size={16} aria-hidden /> Logs
            </Button>
          )}
        </div>
      </div>
    </Panel>
  );
}

export function EnvironmentDetailA() {
  const { projectId } = useProjectContext();
  const { envId } = useParams<{ envId: string }>();
  const navigate = useNavigate();
  const toast = useToast();
  const { env, siblings, environments } = useEnvironment(projectId, envId);
  const profiles = useProfiles(projectId);
  const releases = useReleases(projectId, envId);
  const config = useConfig(projectId, envId);
  const domains = useDomains(projectId, envId);
  const volumes = useVolumes(projectId, envId);
  const actions = useEnvironmentActions(projectId, envId ?? '');
  const askAgent = useAskAgent(projectId);
  const [logs, setLogs] = useState<'all' | 'errors' | null>(null);
  const [addingDomain, setAddingDomain] = useState(false);
  const [pausing, setPausing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [behindOpen, setBehindOpen] = useState(false);

  const back = (
    <Link
      to={withTake(`/projects/${projectId}/deployments`, 'a')}
      className="-ml-2 inline-flex min-h-11 w-fit items-center gap-1 rounded-md px-2 text-sm font-medium text-fg-muted no-underline hover:text-fg-primary"
    >
      <ChevronLeft size={16} aria-hidden /> Deployments
    </Link>
  );

  if (environments.isPending) {
    return (
      <Column>
        {back}
        <Loading label="Loading…" />
      </Column>
    );
  }
  if (!env) {
    return (
      <Column>
        {back}
        <p className="m-0 text-[15px] text-fg-muted">This environment no longer exists.</p>
      </Column>
    );
  }

  const info = describeHealth(env);
  const customDomains = domains.data?.domains ?? [];
  const routes = domains.data?.routes ?? [];
  const address = primaryAddress(env, customDomains);
  const addressCount = customDomains.length + routes.length;
  const problems = [...describeProblems(env), ...domainProblems(customDomains)];
  const profileName = profileNameOf(env.latestRelease?.submittedBy?.agentProfileId, profiles);
  const volumeList = volumes.data?.volumes ?? [];
  const releaseList = releases.data?.releases ?? [];
  const pausedVersion = info.health === 'paused' ? lastGoodVersion(env, releaseList) : null;

  const onFix = (fix: Fix, problem: { title: string }) => {
    if (fix === 'ask-agent') askAgent(problem.title);
    if (fix === 'logs') setLogs('errors');
    if (fix === 'domains') document.getElementById('addresses')?.scrollIntoView({ behavior: 'smooth' });
    if (fix === 'server') {
      setBehindOpen(true);
      document.getElementById('behind-the-scenes')?.scrollIntoView({ behavior: 'smooth' });
    }
    if (fix === 'start') actions.start.mutate();
  };

  return (
    <Column>
      {back}
      <Hero
        env={env}
        info={info}
        hostname={address?.hostname ?? null}
        extraAddresses={Math.max(0, addressCount - 1)}
        projectId={projectId}
        profileName={profileName}
        agentsOn={agentAccess(env, profiles).on}
        onLogs={() => setLogs('all')}
        onStart={() => actions.start.mutate()}
        onAsk={() => askAgent(info.sentence)}
        onAllowAgents={() => actions.setAgentsEnabled.mutate(true)}
      />
      <ProblemList problems={problems} onFix={onFix} />
      <RecentDeploys
        projectId={projectId}
        releases={releaseList}
        liveVersion={info.liveVersion}
        pausedVersion={pausedVersion}
        profiles={profiles}
      />
      <WhoCanDeploy projectId={projectId} env={env} profiles={profiles} />
      <AppSettings projectId={projectId} envId={env.id} rows={config.data?.envVars ?? []} />
      <Addresses
        projectId={projectId}
        env={env}
        answering={isAnswering(info.health)}
        routes={routes}
        domains={customDomains}
        onAddDomain={() => setAddingDomain(true)}
      />
      <SavedData projectId={projectId} env={env} volumes={volumeList} />
      <BehindTheScenes
        projectId={projectId}
        env={env}
        volumes={volumeList}
        open={behindOpen}
        onToggle={setBehindOpen}
      />
      <PauseOrDelete
        env={env}
        siblings={siblings}
        onPause={() => setPausing(true)}
        onStart={() => actions.start.mutate()}
        onDelete={() => setDeleting(true)}
      />

      {logs && (
        <LogsDialog projectId={projectId} env={env} open initialFilter={logs} onClose={() => setLogs(null)} />
      )}
      {addingDomain && (
        <AddDomainDialog projectId={projectId} env={env} routes={routes} open onClose={() => setAddingDomain(false)} />
      )}
      <PauseDialog
        env={env}
        siblings={siblings}
        open={pausing}
        busy={actions.pause.isPending}
        onClose={() => setPausing(false)}
        onConfirm={() => actions.pause.mutate(undefined, { onSuccess: () => setPausing(false) })}
      />
      {deleting && (
        <DeleteDialog
          env={env}
          siblings={siblings}
          volumes={volumeList}
          domainCount={customDomains.length}
          open
          busy={actions.remove.isPending}
          onClose={() => setDeleting(false)}
          onConfirm={() =>
            actions.remove.mutate(undefined, {
              onSuccess: () => {
                toast.success(`${env.name} deleted`);
                void navigate(withTake(`/projects/${projectId}/deployments`, 'a'));
              },
            })
          }
        />
      )}
    </Column>
  );
}
