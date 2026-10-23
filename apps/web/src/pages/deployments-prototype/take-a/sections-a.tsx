/**
 * PROTOTYPE Take A detail sections, top half: problems, recent deploys, who can deploy.
 */
import type { AgentProfile } from '@simple-agent-manager/shared';
import { Button } from '@simple-agent-manager/ui';
import { ChevronDown, CircleAlert, Sparkles, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';

import type { DeploymentEnvironment } from '../../../lib/api';
import { ModelToggleSwitch } from '../../../components/agent-models/ModelToggleSwitch';
import { Panel, SectionTitle } from '../../automation/ui';
import { type ReleaseRecord, useEnvironmentActions, useTaskTitle } from '../data';
import { type Fix, type Problem, agentAccess, ago, profileNameOf, releaseOutcome } from '../model';
import { AgentAvatar, ProfileToggles, TonePill } from '../shared';

const FIX_LABEL: Record<Fix, string> = {
  'ask-agent': 'Ask an agent to fix it',
  logs: 'See logs',
  server: 'See the server',
  domains: 'Check domains',
  start: 'Start again',
  access: 'Change who can deploy',
};

export function ProblemList({
  problems,
  onFix,
}: {
  problems: Problem[];
  onFix: (fix: Fix, problem: Problem) => void;
}) {
  if (problems.length === 0) return null;
  return (
    <section className="flex flex-col gap-3" aria-label="Needs your attention">
      <SectionTitle title="Needs your attention" count={problems.length} />
      {problems.map((problem) => {
        const Icon = problem.tone === 'danger' ? TriangleAlert : CircleAlert;
        return (
          <Panel key={problem.id} tone={problem.tone} className="p-4" label={problem.title}>
            <div className="flex gap-3">
              <Icon
                size={20}
                aria-hidden
                className={`mt-0.5 shrink-0 ${problem.tone === 'danger' ? 'text-danger-fg' : 'text-warning-fg'}`}
              />
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <p className="m-0 text-[15px] font-semibold text-fg-primary">{problem.title}</p>
                <p className="m-0 text-sm text-fg-muted">{problem.body}</p>
                {problem.detail && (
                  <details className="group mt-1">
                    <summary className="inline-flex min-h-11 cursor-pointer list-none items-center gap-1 text-[13px] font-semibold text-fg-muted hover:text-fg-primary [&::-webkit-details-marker]:hidden">
                      <span className="group-open:hidden">Show the error</span>
                      <span className="hidden group-open:inline">Hide the error</span>
                      <ChevronDown size={14} aria-hidden className="transition-transform group-open:rotate-180" />
                    </summary>
                    <pre className="m-0 whitespace-pre-wrap break-words rounded-lg bg-inset p-3 font-mono text-[12px] text-fg-primary [overflow-wrap:anywhere]">
                      {problem.detail}
                    </pre>
                  </details>
                )}
                <div className="mt-2 flex flex-wrap gap-3">
                  {problem.fixes.map((fix) => (
                    <Button key={fix} variant="secondary" onClick={() => onFix(fix, problem)}>
                      {fix === 'ask-agent' && <Sparkles size={16} aria-hidden />}
                      {FIX_LABEL[fix]}
                    </Button>
                  ))}
                </div>
              </div>
            </div>
          </Panel>
        );
      })}
    </section>
  );
}

/** "from “Fix checkout button”" as a link to that chat, when the release came from one. */
export function ChatLink({ projectId, taskId }: { projectId: string; taskId: string | null | undefined }) {
  const title = useTaskTitle(projectId, taskId);
  if (!taskId) return null;
  return (
    <Link
      to={`/projects/${projectId}/tasks/${taskId}`}
      className="min-w-0 break-words text-accent no-underline hover:underline [overflow-wrap:anywhere]"
    >
      “{title.data ?? 'the chat'}”
    </Link>
  );
}

const SHOWN = 4;

export function RecentDeploys({
  projectId,
  releases,
  liveVersion,
  pausedVersion,
  profiles,
}: {
  projectId: string;
  releases: ReleaseRecord[];
  liveVersion: number | null;
  pausedVersion: number | null;
  profiles: AgentProfile[];
}) {
  const [all, setAll] = useState(false);
  if (releases.length === 0) return null;
  const visible = all ? releases : releases.slice(0, SHOWN);
  return (
    <section className="flex flex-col gap-3" aria-label="Recent deploys">
      <SectionTitle title="Recent deploys" hint="Every version agents shipped here, newest first." />
      <Panel className="overflow-hidden">
        <ol className="m-0 list-none p-0">
          {visible.map((release) => {
            const outcome = releaseOutcome(release, liveVersion, pausedVersion);
            const who = profileNameOf(release.submittedBy?.agentProfileId, profiles) ?? 'Someone';
            return (
              <li
                key={release.id}
                className="flex min-h-16 items-start gap-3 border-0 border-b border-solid border-border-default px-4 py-3 last:border-b-0"
              >
                <AgentAvatar name={who} />
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="font-mono text-[13px] font-semibold text-fg-primary">
                      v{release.version}
                    </span>
                    <span className="text-[15px] font-semibold text-fg-primary">{who}</span>
                    {outcome.label !== 'Replaced' && (
                      <TonePill tone={outcome.tone} label={outcome.label} />
                    )}
                  </span>
                  <span className="text-[13px] text-fg-muted">
                    {ago(release.createdAt)}
                    {release.submittedBy?.taskId && (
                      <>
                        {' · from '}
                        <ChatLink projectId={projectId} taskId={release.submittedBy.taskId} />
                      </>
                    )}
                  </span>
                </div>
              </li>
            );
          })}
        </ol>
      </Panel>
      {releases.length > SHOWN && (
        <Button variant="ghost" className="self-start" onClick={() => setAll((value) => !value)}>
          {all ? 'Show fewer' : `Show all ${releases.length}`}
        </Button>
      )}
    </section>
  );
}

/**
 * One switch, then an explicit "any" or "only these". Today an empty allow-list silently
 * means ANY profile may deploy; unticking the last profile widened access. Here "only
 * these" can never be saved empty.
 */
export function WhoCanDeploy({
  projectId,
  env,
  profiles,
}: {
  projectId: string;
  env: DeploymentEnvironment;
  profiles: AgentProfile[];
}) {
  const actions = useEnvironmentActions(projectId, env.id);
  const access = agentAccess(env, profiles);
  const [wantSome, setWantSome] = useState(access.mode === 'some');
  const busy = actions.setAgentsEnabled.isPending || actions.setAllowedProfiles.isPending;
  const selected = env.agentPolicy.allowedDeployProfileIds;
  const showSome = access.on && (wantSome || access.mode === 'some');

  return (
    <section className="flex flex-col gap-3" aria-label="Who can deploy">
      <SectionTitle title="Who can deploy" />
      <Panel className="flex flex-col gap-4 p-4">
        <div className="flex items-start justify-between gap-4">
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="text-[15px] font-semibold text-fg-primary">Agents can deploy here</span>
            <span className="text-[13px] text-fg-muted">
              {access.on
                ? 'New versions go live as soon as an agent ships them.'
                : env.latestRelease
                  ? "Off: no new versions. What's running keeps running."
                  : "Off: agents can't deploy here yet."}
            </span>
          </div>
          <ModelToggleSwitch
            checked={access.on}
            disabled={busy}
            label="Agents can deploy here"
            onChange={() => actions.setAgentsEnabled.mutate(!access.on)}
          />
        </div>
        {access.on && (
          <div className="flex flex-col gap-3 border-0 border-t border-solid border-border-default pt-4">
            <div role="radiogroup" aria-label="Which agents" className="flex flex-wrap gap-2">
              {[
                { id: 'any', label: 'Any agent in this project' },
                { id: 'some', label: 'Only these' },
              ].map((option) => {
                const active = (option.id === 'some') === showSome;
                return (
                  <button
                    key={option.id}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    disabled={busy}
                    onClick={() => {
                      if (option.id === 'any') {
                        setWantSome(false);
                        if (selected.length > 0) actions.setAllowedProfiles.mutate([]);
                      } else {
                        setWantSome(true);
                      }
                    }}
                    className={`inline-flex min-h-11 cursor-pointer items-center rounded-full border px-4 text-sm font-semibold ${
                      active
                        ? 'border-accent bg-[var(--sam-color-accent-primary-tint)] text-fg-primary'
                        : 'border-border-default bg-transparent text-fg-muted hover:text-fg-primary'
                    }`}
                  >
                    {option.label}
                  </button>
                );
              })}
            </div>
            {showSome && (
              <>
                <ProfileToggles
                  profiles={profiles}
                  selected={selected}
                  disabled={busy}
                  onToggle={(id) => {
                    const next = selected.includes(id)
                      ? selected.filter((item) => item !== id)
                      : [...selected, id];
                    if (next.length > 0) actions.setAllowedProfiles.mutate(next);
                  }}
                />
                <span className="text-[13px] text-fg-muted">
                  {selected.length === 0
                    ? 'Pick at least one profile. Until you do, any agent can still deploy.'
                    : selected.length === 1
                      ? 'Keep at least one. To let everyone deploy, choose “Any agent”.'
                      : `${selected.length} profiles can deploy here.`}
                </span>
              </>
            )}
          </div>
        )}
      </Panel>
    </section>
  );
}
