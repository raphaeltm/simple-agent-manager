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
import { LoadError, Loading } from '../../automation/page';
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
  canAskAgent,
  isAnswering,
  primaryAddress,
  profileNameOf,
  TONE_COLOR,
  tint,
  versionOnStart,
} from '../model';
import { AddressLine, AgentAvatar, ChatLink, EnvTitle, HealthMark, useAskAgent } from '../shared';
import { withTake } from '../take';
import { Column, type IndexEntry, OnThisPage } from './column';
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
  hasProblems,
  canStart,
  onStart,
  onAsk,
  onAllowAgents,
}: {
  info: HealthInfo;
  hostname: string | null;
  agentsOn: boolean;
  /** When a problem card below already offers the fix, the hero does not repeat it. */
  hasProblems: boolean;
  /** Start needs a release to bring back. */
  canStart: boolean;
  onStart: () => void;
  onAsk: () => void;
  onAllowAgents: () => void;
}) {
  if (info.health === 'paused') return canStart ? <Button onClick={onStart}>Start again</Button> : null;
  if (info.health === 'down' && hasProblems && agentsOn) return null;
  if (info.health === 'new' || info.health === 'down') {
    // Asking an agent is pointless while agents may not deploy here: offer the switch first.
    // Opens the "who can deploy" choice; it never grants access by itself.
    if (!agentsOn) return <Button onClick={onAllowAgents}>Let agents deploy here…</Button>;
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
  hasProblems,
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
  hasProblems: boolean;
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
            <EnvTitle name={env.name} />
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
            hasProblems={hasProblems}
            canStart={Boolean(versionOnStart(env))}
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
  const [choosingAccess, setChoosingAccess] = useState(false);

  const back = (
    <Link
      to={withTake(`/projects/${projectId}/deployments`, 'a')}
      className="-ml-2 inline-flex min-h-11 w-fit items-center gap-1 rounded-md px-2 text-sm font-medium text-fg-muted no-underline hover:text-fg-primary"
    >
      <ChevronLeft size={16} aria-hidden /> Deployments
    </Link>
  );

  if (environments.isError) {
    return (
      <Column>
        {back}
        <LoadError what="this environment" error={environments.error} onRetry={() => void environments.refetch()} />
      </Column>
    );
  }
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

  const openAccessChoice = () => {
    setChoosingAccess(true);
    document.getElementById('access')?.scrollIntoView({ behavior: 'smooth' });
  };
  const onFix = (fix: Fix, problem: { title: string }) => {
    if (fix === 'access') openAccessChoice();
    if (fix === 'ask-agent') askAgent(problem.title);
    if (fix === 'logs') setLogs('errors');
    if (fix === 'domains') document.getElementById('addresses')?.scrollIntoView({ behavior: 'smooth' });
    if (fix === 'server') {
      setBehindOpen(true);
      document.getElementById('behind-the-scenes')?.scrollIntoView({ behavior: 'smooth' });
    }
    if (fix === 'start') actions.start.mutate();
  };

  const access = agentAccess(env, profiles);
  const settingsCount = config.data?.envVars.length ?? 0;
  const diskSize = volumeList.reduce((sum, volume) => sum + volume.sizeGb, 0);
  const index: IndexEntry[] = [
    ...(problems.length > 0
      ? [{ id: 'problems', label: 'Needs your attention', value: String(problems.length), tone: info.tone }]
      : []),
    ...(releaseList.length > 0 ? [{ id: 'deploys', label: 'Recent deploys', value: String(releaseList.length) }] : []),
    {
      id: 'access',
      label: 'Who can deploy',
      value: !access.on ? 'Off' : access.mode === 'any' ? 'Any agent' : `${access.names.length} only`,
    },
    { id: 'settings', label: 'Settings', value: String(settingsCount) },
    { id: 'addresses', label: 'Addresses', value: String(addressCount) },
    { id: 'data', label: 'Saved data', value: diskSize ? `${diskSize} GB` : 'None' },
    { id: 'behind-the-scenes', label: 'Behind the scenes' },
    { id: 'pause', label: env.status === 'stopped' ? 'Start or delete' : 'Pause or delete' },
  ];

  return (
    <Column aside={<OnThisPage entries={index} />}>
      {back}
      <Hero
        env={env}
        info={info}
        hostname={address?.hostname ?? null}
        extraAddresses={Math.max(0, addressCount - 1)}
        projectId={projectId}
        profileName={profileName}
        agentsOn={agentAccess(env, profiles).on}
        hasProblems={problems.length > 0}
        onLogs={() => setLogs('all')}
        onStart={() => actions.start.mutate()}
        onAsk={() => askAgent(info.sentence)}
        onAllowAgents={openAccessChoice}
      />
      <ProblemList problems={problems} canAskAgent={canAskAgent(env)} onFix={onFix} />
      <RecentDeploys projectId={projectId} env={env} releases={releaseList} profiles={profiles} />
      <WhoCanDeploy
        projectId={projectId}
        env={env}
        profiles={profiles}
        choosing={choosingAccess}
        onChoosingChange={setChoosingAccess}
      />
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
