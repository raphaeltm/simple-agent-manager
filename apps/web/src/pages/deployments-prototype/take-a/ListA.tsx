/**
 * PROTOTYPE Take A, "Calm status page": the Deployments list.
 *
 * What changed from today's list, and why:
 * - The create form is a button. Creating an environment is rare; it no longer takes the
 *   top half of a phone screen.
 * - Environments are grouped by what they need from you: attention first, then running,
 *   then not running. Each appears once, problems at the top in the problem's own words.
 * - Every row names the address people actually visit (custom domain first) with a
 *   one-tap Open button, plus who shipped the running version and when.
 * - One status per row, in words, and only when it is worth noticing. A live app is quiet.
 */
import { Button } from '@simple-agent-manager/ui';
import { ChevronRight, ExternalLink, Plus, Rocket, Sparkles } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';

import type { DeploymentCustomDomain, DeploymentEnvironment } from '../../../lib/api';
import { LoadError, Loading, PageHeader } from '../../automation/page';
import { Panel, SectionTitle } from '../../automation/ui';
import { useProjectContext } from '../../ProjectContext';
import { useAllDomains, useEnvironments, useProfiles } from '../data';
import {
  ago,
  ASKS_AGENT,
  canAskAgent,
  describeHealth,
  describeProblems,
  type Health,
  isAnswering,
  primaryAddress,
  profileNameOf,
  sortForAttention,
  tint,
  TONE_COLOR,
} from '../model';
import { NewEnvironmentDialog } from '../new-environment';
import { HealthMark, TonePill, useAskAgent } from '../shared';
import { withTake } from '../take';
import { Column } from './column';

type Group = 'attention' | 'running' | 'idle';

function groupOf(health: Health): Group {
  if (health === 'down' || health === 'trouble') return 'attention';
  if (health === 'paused' || health === 'new' || health === 'pausing') return 'idle';
  return 'running';
}

const GROUPS: Array<{ id: Group; title: string; hint?: string }> = [
  { id: 'attention', title: 'Needs your attention' },
  { id: 'running', title: 'Running' },
  { id: 'idle', title: 'Not running', hint: 'Paused, or waiting for a first deploy.' },
];

function shippedLine(env: DeploymentEnvironment, profileName: string | null): string | null {
  const release = env.latestRelease;
  if (!release) return null;
  return `v${release.version} by ${profileName ?? 'someone'}, ${ago(release.createdAt)}`;
}

/**
 * One environment. The row opens the environment; the Open button (or, for a problem,
 * "Ask an agent") sits beside it rather than inside it, so taps never collide.
 */
function EnvRow({
  env,
  domains,
  profileName,
  projectId,
}: {
  env: DeploymentEnvironment;
  domains: DeploymentCustomDomain[] | undefined;
  profileName: string | null;
  projectId: string;
}) {
  const info = describeHealth(env);
  const askAgent = useAskAgent(projectId);
  const problem = describeProblems(env)[0];
  const address = primaryAddress(env, domains);
  const answering = isAnswering(info.health);
  const shipped = shippedLine(env, profileName);
  const attention = groupOf(info.health) === 'attention';
  const second = problem
    ? problem.title
    : address && info.health !== 'new'
      ? address.hostname
      : info.sentence;
  return (
    <div
      className="flex min-w-0 flex-col border-0 border-b border-solid border-border-default last:border-b-0 sm:flex-row sm:items-center"
      style={attention ? { background: tint(TONE_COLOR[info.tone], 6) } : undefined}
    >
      <Link
        to={withTake(`/projects/${projectId}/deployments/${env.id}`, 'a')}
        className="group flex min-h-[72px] min-w-0 flex-1 items-center gap-3 py-3 pl-4 pr-3 no-underline hover:bg-surface-hover"
      >
        <HealthMark info={info} />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <span
              title={env.name}
              className="line-clamp-2 min-w-0 break-words text-[15px] font-semibold leading-snug text-fg-primary [overflow-wrap:anywhere]"
            >
              {env.name}
            </span>
            {info.health !== 'live' && !attention && <TonePill tone={info.tone} label={info.label} />}
          </span>
          <span
            className={`min-w-0 break-words text-[13px] [overflow-wrap:anywhere] ${problem ? 'font-medium' : 'text-fg-muted'}`}
            style={problem ? { color: TONE_COLOR[info.tone] } : undefined}
          >
            {second}
          </span>
          {shipped && <span className="text-xs text-fg-muted">{shipped}</span>}
        </span>
        <ChevronRight
          size={18}
          aria-hidden
          className="shrink-0 text-fg-muted transition-transform group-hover:translate-x-0.5"
        />
      </Link>
      {attention ? (
        // "Ask an agent" only where an agent may deploy and the problem is the app's to fix;
        // a silent server or a closed environment needs a look, not a deploy.
        canAskAgent(env) && problem?.fixes.some((fix) => ASKS_AGENT.has(fix)) ? (
          <div className="flex pb-3 pl-[68px] sm:pb-0 sm:pl-0 sm:pr-4">
            <Button variant="secondary" onClick={() => askAgent(problem.title)}>
              <Sparkles size={16} aria-hidden /> Ask an agent
            </Button>
          </div>
        ) : null
      ) : (
        answering &&
        address && (
          <a
            href={`https://${address.hostname}`}
            target="_blank"
            rel="noreferrer"
            aria-label={`Open ${env.name}`}
            className="mb-3 ml-[68px] inline-flex min-h-11 w-fit shrink-0 items-center gap-2 rounded-lg border border-border-default px-4 text-sm font-semibold text-fg-primary no-underline hover:bg-surface-hover sm:mb-0 sm:ml-0 sm:mr-4"
          >
            Open <ExternalLink size={15} aria-hidden />
          </a>
        )
      )}
    </div>
  );
}

function EmptyA({ onCreate }: { onCreate: () => void }) {
  return (
    <Panel className="flex flex-col items-center gap-4 px-6 py-10 text-center" label="Nothing deployed yet">
      <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-[var(--sam-color-accent-primary-tint)] text-accent">
        <Rocket size={26} aria-hidden />
      </span>
      <div className="flex max-w-md flex-col gap-2">
        <h2 className="m-0 text-[19px] font-semibold text-fg-primary">Nothing deployed yet</h2>
        <p className="m-0 text-[15px] text-fg-muted">
          Agents can put this project on the internet for you. Create an environment, choose which
          agents may deploy there, then ask one: “deploy this to staging”.
        </p>
      </div>
      <Button onClick={onCreate}>
        <Plus size={18} aria-hidden /> New environment
      </Button>
      <a
        href="https://simple-agent-manager.org/docs/guides/app-deployments/"
        target="_blank"
        rel="noreferrer"
        className="inline-flex min-h-11 items-center text-sm font-semibold text-accent no-underline hover:underline"
      >
        How deployments work
      </a>
    </Panel>
  );
}

export function DeploymentsListA() {
  const { projectId } = useProjectContext();
  const navigate = useNavigate();
  const environments = useEnvironments(projectId);
  const envs = useMemo(() => sortForAttention(environments.data ?? []), [environments.data]);
  const domainResults = useAllDomains(projectId, envs);
  const profiles = useProfiles(projectId);
  const [creating, setCreating] = useState(false);

  const domainsByEnv = new Map(
    envs.map((env, index) => [env.id, domainResults[index]?.data?.customDomains])
  );

  return (
    <Column>
      <PageHeader
        title="Deployments"
        subtitle="Your app, live on the internet. Agents ship it; you decide where."
        action={
          envs.length > 0 ? (
            <Button variant="secondary" onClick={() => setCreating(true)} className="shrink-0">
              <Plus size={18} aria-hidden /> New
            </Button>
          ) : undefined
        }
      />
      {environments.isError ? (
        <LoadError what="deployments" error={environments.error} onRetry={() => void environments.refetch()} />
      ) : environments.isPending ? (
        <Loading label="Loading deployments…" />
      ) : envs.length === 0 ? (
        <EmptyA onCreate={() => setCreating(true)} />
      ) : (
        <>
          {GROUPS.map((group) => {
            const members = envs.filter((env) => groupOf(describeHealth(env).health) === group.id);
            if (members.length === 0) return null;
            return (
              <section key={group.id} className="flex flex-col gap-3" aria-label={group.title}>
                <SectionTitle
                  title={group.title}
                  count={members.length}
                  hint={
                    group.id === 'running' &&
                    members.some((env) => ['deploying', 'starting'].includes(describeHealth(env).health))
                      ? 'Ones starting or deploying are offline until they’re up.'
                      : group.hint
                  }
                />
                <Panel className="overflow-hidden">
                  {members.map((env) => (
                    <EnvRow
                      key={env.id}
                      env={env}
                      projectId={projectId}
                      domains={domainsByEnv.get(env.id)}
                      profileName={profileNameOf(env.latestRelease?.submittedBy?.agentProfileId, profiles)}
                    />
                  ))}
                </Panel>
              </section>
            );
          })}
          <p className="m-0 text-[13px] text-fg-muted">
            Agents deploy for you. Ask in any chat, for example “deploy this branch to staging”.
          </p>
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
          void navigate(withTake(`/projects/${projectId}/deployments/${envId}`, 'a'));
        }}
      />
    </Column>
  );
}
