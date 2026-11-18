/**
 * One deployment environment.
 *
 * One scroll instead of seven tabs, ordered by why people open the page:
 * 1. Is it up, and where is it? (status in words, the address, Open)
 * 2. If not, what do I do? (problems, each with its fix)
 * 3. What shipped, by which agent, from which chat?
 * 4. Who may ship here, what the app reads, where it answers, what data it keeps.
 * 5. Server internals, collapsed. Pause and Delete at the very bottom, with Delete
 *    behind a typed confirmation instead of a red button beside Stop.
 */
import { ChevronLeft } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';

import { LoadError, Loading } from '../../components/page-kit/page';
import { useToast } from '../../hooks/useToast';
import { useProjectContext } from '../ProjectContext';
import { Column, type IndexEntry, OnThisPage } from './column';
import {
  useConfig,
  useDomains,
  useEnvironment,
  useEnvironmentActions,
  useProfiles,
  useReleases,
  useVolumes,
} from './data';
import { AddDomainDialog, DeleteDialog, LogsDialog, PauseDialog } from './dialogs';
import { domainProblems, primaryAddress } from './domains';
import { Hero } from './hero';
import {
  agentAccess,
  ASKS_AGENT,
  canAskAgent,
  describeHealth,
  describeProblems,
  type Fix,
  isAnswering,
  profileNameOf,
} from './model';
import { PauseOrDelete, pauseOrDeleteTitle } from './pause-or-delete';
import { ProblemList } from './problems';
import { RecentDeploys } from './recent-deploys';
import { Addresses } from './sections/addresses';
import { AppSettings } from './sections/app-settings';
import { BehindTheScenes } from './sections/behind';
import { SavedData } from './sections/saved-data';
import { WhoCanDeploy } from './sections/who-can-deploy';
import { useAskAgent } from './shared';

/** Two sections side by side from 1280 px; one column (page order) below that. */
const PAIR = 'grid grid-cols-1 items-start gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]';

export function EnvironmentPage() {
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
      to={`/projects/${projectId}/deployments`}
      className="-ml-2 inline-flex min-h-11 w-fit items-center gap-1 rounded-md px-2 text-sm font-medium text-fg-muted no-underline hover:text-fg-primary"
    >
      <ChevronLeft size={16} aria-hidden /> Deployments
    </Link>
  );

  if (environments.isError) {
    return (
      <Column>
        {back}
        <LoadError
          what="this environment"
          error={environments.error}
          onRetry={() => void environments.refetch()}
        />
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
  const volumeList = volumes.data?.volumes ?? [];
  const releaseList = releases.data?.releases ?? [];
  // Credit the version the sentence names: "Running version 42" is about v42, not the v43
  // that failed after it (that one has its own problem card).
  const credit =
    info.liveVersion !== null
      ? (releaseList.find((release) => release.version === info.liveVersion) ??
        (env.latestRelease?.version === info.liveVersion ? env.latestRelease : null))
      : (releaseList[0] ?? env.latestRelease ?? null);
  const profileName = profileNameOf(credit?.submittedBy?.agentProfileId, profiles);

  const openAccessChoice = () => {
    setChoosingAccess(true);
    document.getElementById('access')?.scrollIntoView({ behavior: 'smooth' });
  };
  const onFix = (fix: Fix) => {
    if (fix === 'access') openAccessChoice();
    if (ASKS_AGENT.has(fix)) askAgent(env.name, fix === 'redeploy' ? 'deploy' : 'fix');
    if (fix === 'logs') setLogs('errors');
    if (fix === 'domains')
      document.getElementById('addresses')?.scrollIntoView({ behavior: 'smooth' });
    if (fix === 'server') {
      setBehindOpen(true);
      document.getElementById('behind-the-scenes')?.scrollIntoView({ behavior: 'smooth' });
    }
    if (fix === 'start') actions.start.mutate();
    if (fix === 'pause') setPausing(true);
  };

  const access = agentAccess(env, profiles);
  const settingsCount = config.data?.envVars.length ?? 0;
  const diskSize = volumeList.reduce((sum, volume) => sum + volume.sizeGb, 0);
  const index: IndexEntry[] = [
    ...(problems.length > 0
      ? [
          {
            id: 'problems',
            label: 'Needs your attention',
            value: String(problems.length),
            tone: info.tone,
          },
        ]
      : []),
    ...(releaseList.length > 0
      ? [{ id: 'deploys', label: 'Recent deploys', value: String(releaseList.length) }]
      : []),
    {
      id: 'access',
      label: 'Who can deploy',
      value: !access.on
        ? 'Off'
        : access.mode === 'any'
          ? 'Any agent'
          : `${access.names.length} only`,
    },
    // A count the page has not loaded yet is left blank, never shown as 0 or None.
    { id: 'settings', label: 'Settings', value: config.data ? String(settingsCount) : undefined },
    { id: 'addresses', label: 'Addresses', value: domains.data ? String(addressCount) : undefined },
    {
      id: 'data',
      label: 'Saved data',
      value: volumes.data ? (diskSize ? `${diskSize} GB` : 'None') : undefined,
    },
    { id: 'behind-the-scenes', label: 'Behind the scenes' },
    { id: 'pause', label: pauseOrDeleteTitle(env) },
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
        credit={credit}
        profileName={profileName}
        agentsOn={agentAccess(env, profiles).on}
        hasProblems={problems.length > 0}
        onLogs={() => setLogs('all')}
        onStart={() => actions.start.mutate()}
        onAsk={() => askAgent(env.name, info.health === 'new' ? 'deploy' : 'fix')}
        onAllowAgents={openAccessChoice}
      />
      <ProblemList problems={problems} canAskAgent={canAskAgent(env)} onFix={onFix} />
      {releases.isError && !releases.data ? (
        <LoadError
          what="recent deploys"
          error={releases.error}
          onRetry={() => void releases.refetch()}
        />
      ) : (
        <RecentDeploys projectId={projectId} env={env} releases={releaseList} profiles={profiles} />
      )}
      {/* Desktop is wide enough for two phone-width columns: pairing the shorter sections
          halves the scroll without changing their order on a phone. */}
      <div className={PAIR}>
        <WhoCanDeploy
          projectId={projectId}
          env={env}
          profiles={profiles}
          choosing={choosingAccess}
          onChoosingChange={setChoosingAccess}
        />
        {config.isError && !config.data ? (
          <LoadError
            what="the settings"
            error={config.error}
            onRetry={() => void config.refetch()}
          />
        ) : (
          <AppSettings
            projectId={projectId}
            envId={env.id}
            rows={config.data?.envVars ?? []}
            loading={!config.data}
          />
        )}
      </div>
      <div className={PAIR}>
        {domains.isError && !domains.data ? (
          <LoadError
            what="the addresses"
            error={domains.error}
            onRetry={() => void domains.refetch()}
          />
        ) : (
          <Addresses
            projectId={projectId}
            env={env}
            answering={isAnswering(info.health)}
            routes={routes}
            domains={customDomains}
            loading={!domains.data}
            onAddDomain={() => setAddingDomain(true)}
          />
        )}
        {volumes.isError && !volumes.data ? (
          <LoadError
            what="the disks"
            error={volumes.error}
            onRetry={() => void volumes.refetch()}
          />
        ) : (
          <SavedData projectId={projectId} env={env} volumes={volumeList} loading={!volumes.data} />
        )}
      </div>
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
        <LogsDialog
          projectId={projectId}
          env={env}
          open
          initialFilter={logs}
          onClose={() => setLogs(null)}
        />
      )}
      {addingDomain && (
        <AddDomainDialog
          projectId={projectId}
          env={env}
          routes={routes}
          open
          onClose={() => setAddingDomain(false)}
        />
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
                void navigate(`/projects/${projectId}/deployments`);
              },
            })
          }
        />
      )}
    </Column>
  );
}
