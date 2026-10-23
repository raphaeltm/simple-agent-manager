/**
 * PROTOTYPE Take B, "Release timeline": the Deployments list.
 *
 * In SAM people do not deploy; agents do. So this take puts what agents SHIPPED at the
 * centre: a strip of environments (where things run) above one feed of every deploy across
 * the project, each naming the agent, the chat it came from, and what happened.
 */
import { Button } from '@simple-agent-manager/ui';
import { Lock, Plus, Rocket, ScrollText, Sparkles, Users } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';

import type { DeploymentCustomDomain, DeploymentEnvironment } from '../../../lib/api';
import { Loading, PageHeader } from '../../automation/page';
import { Chips, Panel, SectionTitle } from '../../automation/ui';
import { useProjectContext } from '../../ProjectContext';
import { type ReleaseRecord, useAllDomains, useAllReleases, useEnvironments, useProfiles } from '../data';
import { LogsDialog } from '../dialogs';
import {
  agentAccess,
  ago,
  describeHealth,
  describeProblems,
  liveVersionOf,
  primaryAddress,
  profileNameOf,
  releaseOutcome,
  sortForAttention,
  TONE_COLOR,
} from '../model';
import { NewEnvironmentDialog } from '../new-environment';
import { AgentAvatar, ChatLink, TonePill, useAskAgent } from '../shared';
import { withTake } from '../take';

function versionLine(env: DeploymentEnvironment): string {
  const info = describeHealth(env);
  const latest = env.latestRelease?.version;
  if (info.health === 'deploying' && latest) return info.liveVersion ? `v${info.liveVersion} → v${latest}` : `→ v${latest}`;
  if (info.liveVersion) return `v${info.liveVersion}`;
  if (info.health === 'paused' && latest) return `v${latest}`;
  return '—';
}

function EnvCard({
  env,
  domains,
  projectId,
  accessLabel,
}: {
  env: DeploymentEnvironment;
  domains: DeploymentCustomDomain[] | undefined;
  projectId: string;
  accessLabel: { on: boolean; text: string };
}) {
  const info = describeHealth(env);
  const color = TONE_COLOR[info.tone];
  const address = primaryAddress(env, domains);
  const problem = describeProblems(env)[0];
  return (
    <Link
      to={withTake(`/projects/${projectId}/deployments/${env.id}`, 'b')}
      className="group relative flex min-h-[148px] w-[264px] shrink-0 snap-start flex-col gap-2 overflow-hidden rounded-xl border border-border-default p-4 no-underline glass-surface hover:border-[var(--sam-color-fg-muted)] sm:w-auto"
    >
      <span aria-hidden className="absolute inset-y-0 left-0 w-1" style={{ background: color }} />
      <span className="flex items-start justify-between gap-3">
        <span className="line-clamp-2 min-w-0 break-words text-[15px] font-semibold leading-snug text-fg-primary [overflow-wrap:anywhere]">
          {env.name}
        </span>
        <span className="shrink-0 font-mono text-[13px] font-semibold text-fg-primary">{versionLine(env)}</span>
      </span>
      <span className="flex items-start gap-1.5 text-[13px] font-semibold" style={{ color }}>
        <span aria-hidden className="mt-[5px] h-2 w-2 shrink-0 rounded-full" style={{ background: color }} />
        <span className="line-clamp-2">{problem?.title ?? info.label}</span>
      </span>
      <span className="truncate text-[13px] text-fg-muted">{address?.hostname ?? 'No address yet'}</span>
      <span className="mt-auto flex items-center gap-1.5 text-xs text-fg-muted">
        {accessLabel.on ? <Users size={13} aria-hidden /> : <Lock size={13} aria-hidden />}
        {accessLabel.text}
      </span>
    </Link>
  );
}

type FeedFilter = 'all' | 'problems' | 'live';

interface FeedItem {
  release: ReleaseRecord;
  env: DeploymentEnvironment;
}

function dayLabel(iso: string): string {
  const date = new Date(iso);
  const today = new Date();
  const days = Math.floor(
    (new Date(today.toDateString()).getTime() - new Date(date.toDateString()).getTime()) / 86_400_000
  );
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return 'Earlier this week';
  return 'Older';
}

function FeedEntry({
  item,
  projectId,
  profileName,
  keptVersion,
  onLogs,
}: {
  item: FeedItem;
  projectId: string;
  profileName: string;
  /** The version that stayed live when this one failed: the newest earlier success. */
  keptVersion: number | null;
  onLogs: () => void;
}) {
  const { release, env } = item;
  const askAgent = useAskAgent(projectId);
  const live = liveVersionOf(env);
  const outcome = releaseOutcome(release, live, env.status === 'stopped' ? release.version : null);
  const failed = outcome.label === "Didn't start";
  const verb = outcome.label === 'Deploying' ? 'is deploying' : failed ? 'tried to ship' : 'shipped';
  return (
    <li className="flex gap-3 border-0 border-b border-solid border-border-default px-4 py-3 last:border-b-0">
      <AgentAvatar name={profileName} size={36} />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="m-0 min-w-0 break-words text-[15px] leading-snug text-fg-primary [overflow-wrap:anywhere]">
          <span className="font-semibold">{profileName}</span> {verb}{' '}
          <span className="font-mono text-[14px] font-semibold">v{release.version}</span> to{' '}
          <Link
            to={withTake(`/projects/${projectId}/deployments/${env.id}`, 'b')}
            className="font-semibold text-fg-primary underline decoration-[var(--sam-color-border-default)] underline-offset-4 hover:decoration-current"
          >
            {env.name}
          </Link>
        </p>
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-fg-muted">
          {outcome.label !== 'Replaced' && <TonePill tone={outcome.tone} label={outcome.label} />}
          {failed && <span>{keptVersion ? `v${keptVersion} kept running` : 'nothing was live yet'}</span>}
          <span>{ago(release.createdAt)}</span>
          {release.submittedBy?.taskId && (
            <span className="min-w-0">
              from <ChatLink projectId={projectId} taskId={release.submittedBy.taskId} />
            </span>
          )}
        </span>
        {failed && release.id === env.latestRelease?.id && (
          <div className="mt-1 flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => askAgent(`v${release.version} didn't start`)}>
              <Sparkles size={16} aria-hidden /> Ask an agent to fix it
            </Button>
            <Button variant="ghost" onClick={onLogs}>
              <ScrollText size={16} aria-hidden /> Logs
            </Button>
          </div>
        )}
      </div>
    </li>
  );
}

function EmptyB({ onCreate }: { onCreate: () => void }) {
  const steps = [
    ['Create an environment', 'A place for one running copy of your app, like “staging”.'],
    ['Choose which agents may deploy', 'Any agent, or only the profiles you trust with it.'],
    ['Ask an agent to ship it', 'In any chat: “deploy this to staging”. Every deploy shows up here.'],
  ];
  return (
    <Panel className="flex flex-col gap-6 px-5 py-8 sm:px-8" label="No deploys yet">
      <div className="flex items-center gap-3">
        <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-[var(--sam-color-accent-primary-tint)] text-accent">
          <Rocket size={22} aria-hidden />
        </span>
        <div className="flex flex-col">
          <h2 className="m-0 text-[19px] font-semibold text-fg-primary">No deploys yet</h2>
          <p className="m-0 text-sm text-fg-muted">Three steps and your agents can put this app online.</p>
        </div>
      </div>
      <ol className="m-0 flex list-none flex-col gap-4 p-0">
        {steps.map(([title, body], index) => (
          <li key={title} className="flex gap-3">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-border-default font-mono text-[13px] font-semibold text-fg-primary">
              {index + 1}
            </span>
            <span className="flex flex-col">
              <span className="text-[15px] font-semibold text-fg-primary">{title}</span>
              <span className="text-sm text-fg-muted">{body}</span>
            </span>
          </li>
        ))}
      </ol>
      <Button className="self-start" onClick={onCreate}>
        <Plus size={18} aria-hidden /> New environment
      </Button>
    </Panel>
  );
}

const FILTERS: Array<{ id: FeedFilter; label: string }> = [
  { id: 'all', label: 'Everything' },
  { id: 'problems', label: 'Problems' },
  { id: 'live', label: 'Live now' },
];

export function DeploymentsListB() {
  const { projectId } = useProjectContext();
  const navigate = useNavigate();
  const environments = useEnvironments(projectId);
  const envs = useMemo(() => sortForAttention(environments.data ?? []), [environments.data]);
  const domainResults = useAllDomains(projectId, envs);
  const releaseResults = useAllReleases(projectId, envs);
  const profiles = useProfiles(projectId);
  const [filter, setFilter] = useState<FeedFilter>('all');
  const [creating, setCreating] = useState(false);
  const [logsFor, setLogsFor] = useState<DeploymentEnvironment | null>(null);

  const releasesByEnv = new Map(envs.map((env, index) => [env.id, releaseResults[index]?.data?.releases ?? []]));
  const feed: FeedItem[] = envs
    .flatMap((env, index) =>
      (releaseResults[index]?.data?.releases ?? []).map((release) => ({ release, env }))
    )
    .sort((a, b) => b.release.createdAt.localeCompare(a.release.createdAt))
    .filter(({ release, env }) => {
      const outcome = releaseOutcome(release, liveVersionOf(env));
      if (filter === 'problems') return outcome.label === "Didn't start";
      if (filter === 'live') return outcome.label === 'Live';
      return true;
    });
  const days = [...new Set(feed.map((item) => dayLabel(item.release.createdAt)))];

  return (
    <div className="w-full min-w-0">
      <div className="mx-auto flex w-full min-w-0 max-w-[1080px] flex-col gap-6 pb-16">
        <PageHeader
          title="Deployments"
          subtitle="What your agents shipped, and where it's live."
          action={
            envs.length > 0 ? (
              <Button variant="secondary" onClick={() => setCreating(true)} className="shrink-0">
                <Plus size={18} aria-hidden /> New
              </Button>
            ) : undefined
          }
        />
        {environments.isPending ? (
          <Loading label="Loading deployments…" />
        ) : envs.length === 0 ? (
          <EmptyB onCreate={() => setCreating(true)} />
        ) : (
          <>
            <section className="flex flex-col gap-3" aria-label="Where it runs">
              <SectionTitle title="Where it runs" count={envs.length} />
              <div
                data-intentional-clip
                className="-mx-3 flex snap-x snap-mandatory gap-3 overflow-x-auto px-3 pb-2 sm:mx-0 sm:grid sm:snap-none sm:grid-cols-2 sm:overflow-visible sm:px-0 lg:grid-cols-3"
              >
                {envs.map((env, index) => {
                  const access = agentAccess(env, profiles);
                  return (
                    <EnvCard
                      key={env.id}
                      env={env}
                      projectId={projectId}
                      domains={domainResults[index]?.data?.customDomains}
                      accessLabel={{
                        on: access.on,
                        text: !access.on
                          ? 'Agents off'
                          : access.mode === 'any'
                            ? 'Any agent can deploy'
                            : `${access.names.length} ${access.names.length === 1 ? 'profile' : 'profiles'} can deploy`,
                      }}
                    />
                  );
                })}
              </div>
            </section>

            <section className="flex flex-col gap-3" aria-label="Deploy activity">
              <SectionTitle title="Deploy activity" hint="Every version agents shipped, newest first." />
              <Chips options={FILTERS} value={filter} onChange={setFilter} label="Show" />
              {days.length === 0 ? (
                <p className="m-0 rounded-xl bg-surface-hover px-4 py-6 text-center text-sm text-fg-muted">
                  Nothing here for this filter.
                </p>
              ) : (
                days.map((day) => (
                  <div key={day} className="flex flex-col gap-2">
                    <h3 className="m-0 text-[13px] font-semibold uppercase tracking-wide text-fg-muted">{day}</h3>
                    <Panel className="overflow-hidden">
                      <ol className="m-0 list-none p-0">
                        {feed
                          .filter((item) => dayLabel(item.release.createdAt) === day)
                          .map((item) => (
                            <FeedEntry
                              key={item.release.id}
                              item={item}
                              projectId={projectId}
                              profileName={profileNameOf(item.release.submittedBy?.agentProfileId, profiles) ?? 'Someone'}
                              keptVersion={
                                (releasesByEnv.get(item.env.id) ?? []).find(
                                  (other) => other.version < item.release.version && other.status === 'applied'
                                )?.version ?? null
                              }
                              onLogs={() => setLogsFor(item.env)}
                            />
                          ))}
                      </ol>
                    </Panel>
                  </div>
                ))
              )}
            </section>
          </>
        )}
        <NewEnvironmentDialog
          projectId={projectId}
          profiles={profiles}
          existing={envs.map((env) => env.name)}
          open={creating}
          onClose={() => setCreating(false)}
          onCreated={(envId) => {
            setCreating(false);
            void navigate(withTake(`/projects/${projectId}/deployments/${envId}`, 'b'));
          }}
        />
        {logsFor && (
          <LogsDialog projectId={projectId} env={logsFor} open initialFilter="errors" onClose={() => setLogsFor(null)} />
        )}
      </div>
    </div>
  );
}

