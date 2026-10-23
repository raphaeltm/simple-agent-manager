/**
 * PROTOTYPE Take B, "Release timeline": one environment.
 *
 * Three sections instead of seven tabs: Releases (what agents shipped, the default),
 * Settings (one row per thing you can change, each opening its own sheet) and Health
 * (checks in words, then logs). Phones switch between them with a segmented control;
 * desktop shows the timeline beside a side panel, so nothing hides behind a tab.
 * Pause and Delete live in the ⋯ menu, away from everyday controls.
 */
import { DropdownMenu } from '@simple-agent-manager/ui';
import { ChevronLeft, MoreHorizontal, Pause, Play, ScrollText, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';

import { useToast } from '../../../hooks/useToast';
import { Loading } from '../../automation/page';
import { Panel, SectionTitle } from '../../automation/ui';
import { useProjectContext } from '../../ProjectContext';
import {
  useConfig,
  useDomains,
  useEnvironment,
  useEnvironmentActions,
  useLogs,
  useProfiles,
  useReleases,
  useVolumes,
} from '../data';
import { AddDomainDialog, DeleteDialog, LogsDialog, PauseDialog } from '../dialogs';
import {
  describeHealth,
  isAnswering,
  lastGoodVersion,
  primaryAddress,
  TONE_COLOR,
} from '../model';
import { AddressLine, LogList, TonePill } from '../shared';
import { withTake } from '../take';
import { HealthList, SettingsRows, SettingsSheet, type SheetKey } from './side-b';
import { ReleaseTimeline } from './timeline-b';

type Pane = 'releases' | 'settings' | 'health';

const PANES: Array<{ id: Pane; label: string }> = [
  { id: 'releases', label: 'Releases' },
  { id: 'settings', label: 'Settings' },
  { id: 'health', label: 'Health' },
];

function Segmented({ value, onChange }: { value: Pane; onChange: (pane: Pane) => void }) {
  return (
    <div role="tablist" aria-label="Environment sections" className="flex rounded-xl border border-border-default bg-inset p-1 lg:hidden">
      {PANES.map((pane) => (
        <button
          key={pane.id}
          type="button"
          role="tab"
          aria-selected={value === pane.id}
          onClick={() => onChange(pane.id)}
          className={`min-h-11 flex-1 cursor-pointer rounded-lg border-0 text-sm font-semibold ${
            value === pane.id ? 'bg-surface text-fg-primary shadow-sm' : 'bg-transparent text-fg-muted'
          }`}
        >
          {pane.label}
        </button>
      ))}
    </div>
  );
}

function RecentLogs({ projectId, envId, onOpen }: { projectId: string; envId: string; onOpen: () => void }) {
  const logs = useLogs(projectId, envId, 'all', true);
  const entries = (logs.data?.entries ?? []).slice(0, 4);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold text-fg-primary">Latest log lines</span>
        <button
          type="button"
          onClick={onOpen}
          className="inline-flex min-h-11 cursor-pointer items-center gap-1.5 rounded-md border-0 bg-transparent px-2 text-[13px] font-semibold text-accent hover:bg-surface-hover"
        >
          <ScrollText size={14} aria-hidden /> All logs
        </button>
      </div>
      <LogList
        entries={entries}
        empty={logs.data?.unavailableReason === 'node_stale' ? "The server hasn't checked in, so no fresh logs." : 'No log lines yet.'}
      />
    </div>
  );
}

export function EnvironmentDetailB() {
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
  const [pane, setPane] = useState<Pane>('releases');
  const [sheet, setSheet] = useState<SheetKey | null>(null);
  const [logs, setLogs] = useState<'all' | 'errors' | null>(null);
  const [addingDomain, setAddingDomain] = useState(false);
  const [pausing, setPausing] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const back = (
    <Link
      to={withTake(`/projects/${projectId}/deployments`, 'b')}
      className="-ml-2 inline-flex min-h-11 w-fit items-center gap-1 rounded-md px-2 text-sm font-medium text-fg-muted no-underline hover:text-fg-primary"
    >
      <ChevronLeft size={16} aria-hidden /> Deployments
    </Link>
  );
  const frame = (children: React.ReactNode) => (
    <div className="w-full min-w-0">
      <div className="mx-auto flex w-full min-w-0 max-w-[1080px] flex-col gap-5 pb-16">{children}</div>
    </div>
  );

  if (environments.isPending) return frame(<>{back}<Loading label="Loading…" /></>);
  if (!env) return frame(<>{back}<p className="m-0 text-[15px] text-fg-muted">This environment no longer exists.</p></>);

  const info = describeHealth(env);
  const customDomains = domains.data?.domains ?? [];
  const routes = domains.data?.routes ?? [];
  const address = primaryAddress(env, customDomains);
  const answering = isAnswering(info.health);
  const releaseList = releases.data?.releases ?? [];
  const pausedVersion = info.health === 'paused' ? lastGoodVersion(env, releaseList) : null;
  const configRows = config.data?.envVars ?? [];
  const volumeList = volumes.data?.volumes ?? [];
  const show = (target: Pane) => (pane === target ? 'flex' : 'hidden lg:flex');

  return frame(
    <>
      {back}
      <header className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1.5">
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
            <h1 className="m-0 break-words text-[22px] font-bold leading-tight tracking-[-0.01em] text-fg-primary [overflow-wrap:anywhere] sm:text-[26px]">
              {env.name}
            </h1>
            <TonePill tone={info.tone} label={info.label} />
          </div>
          {address && <AddressLine hostname={address.hostname} answering={answering} />}
          <p className="m-0 text-sm text-fg-muted">
            <span style={{ color: TONE_COLOR[info.tone] }} aria-hidden>
              ●{' '}
            </span>
            {info.sentence}
          </p>
        </div>
        <DropdownMenu
          aria-label="More actions"
          trigger={<MoreHorizontal size={20} aria-hidden />}
          items={[
            env.status === 'stopped'
              ? { id: 'start', label: 'Start again', icon: <Play size={15} />, onClick: () => actions.start.mutate() }
              : {
                  id: 'pause',
                  label: 'Pause',
                  icon: <Pause size={15} />,
                  disabled: env.status !== 'active' && env.status !== 'error',
                  onClick: () => setPausing(true),
                },
            { id: 'delete', label: 'Delete environment…', icon: <Trash2 size={15} />, variant: 'danger', onClick: () => setDeleting(true) },
          ]}
        />
      </header>

      <Segmented value={pane} onChange={setPane} />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_360px] lg:items-start">
        <section className={`${show('releases')} min-w-0 flex-col gap-3`} aria-label="Releases">
          <div className="hidden lg:block">
            <SectionTitle title="Releases" hint="What agents shipped here, newest first." />
          </div>
          <ReleaseTimeline
            projectId={projectId}
            env={env}
            releases={releaseList}
            liveVersion={info.liveVersion}
            pausedVersion={pausedVersion}
            profiles={profiles}
            liveAddress={answering ? (address?.hostname ?? null) : null}
            onLogs={setLogs}
          />
        </section>

        <div className="flex min-w-0 flex-col gap-6 lg:sticky lg:top-4">
          <section className={`${show('health')} min-w-0 flex-col gap-3`} aria-label="Health">
            <div className="hidden lg:block">
              <SectionTitle title="Health" />
            </div>
            <Panel className="flex flex-col gap-4 p-4">
              <HealthList env={env} />
              {env.latestRelease && env.status !== 'stopped' && (
                <RecentLogs projectId={projectId} envId={env.id} onOpen={() => setLogs('all')} />
              )}
            </Panel>
          </section>
          <section className={`${show('settings')} min-w-0 flex-col gap-3`} aria-label="Settings">
            <div className="hidden lg:block">
              <SectionTitle title="Settings" />
            </div>
            <SettingsRows
              env={env}
              profiles={profiles}
              config={configRows}
              domains={customDomains}
              volumes={volumeList}
              onOpen={setSheet}
            />
          </section>
        </div>
      </div>

      <SettingsSheet
        sheet={sheet}
        projectId={projectId}
        env={env}
        profiles={profiles}
        config={configRows}
        routes={routes}
        domains={customDomains}
        volumes={volumeList}
        answering={answering}
        onAddDomain={() => {
          setSheet(null);
          setAddingDomain(true);
        }}
        onClose={() => setSheet(null)}
      />
      {logs && <LogsDialog projectId={projectId} env={env} open initialFilter={logs} onClose={() => setLogs(null)} />}
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
                void navigate(withTake(`/projects/${projectId}/deployments`, 'b'));
              },
            })
          }
        />
      )}
    </>
  );
}
