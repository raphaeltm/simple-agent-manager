/**
 * "Recent deploys": every version agents shipped here, newest first, with who sent it and
 * the chat it came from. While the newest version deploys, or after it fails, its row also
 * shows the steps the server reported (`steps.ts`), so a failed deploy says which step broke
 * and whether the previous version came back.
 */
import type { AgentProfile } from '@simple-agent-manager/shared';
import { Button } from '@simple-agent-manager/ui';
import { Check, LoaderCircle, X } from 'lucide-react';
import { useState } from 'react';

import type { DeploymentEnvironment, DeploymentReleaseSummary } from '../../lib/api';
import { Panel, SectionTitle } from '../automation/ui';
import { useReleaseEvents } from './data';
import { ago, tint } from './format';
import { placementFailed, profileNameOf, releaseOutcome } from './model';
import { AgentAvatar, ChatLink, TonePill } from './shared';
import { collapseSteps, stepLabel, type StepState } from './steps';

const SHOWN = 4;

const STEP_COLOR: Record<StepState, string> = {
  done: 'var(--sam-color-success-fg)',
  running: 'var(--sam-color-info-fg)',
  failed: 'var(--sam-color-danger-fg)',
};

function Steps({
  projectId,
  env,
  release,
  over,
}: {
  projectId: string;
  env: DeploymentEnvironment;
  release: DeploymentReleaseSummary;
  /** The apply has ended (the release failed); false follows it live. */
  over: boolean;
}) {
  const events = useReleaseEvents(projectId, env.id, release.id, true, !over);
  const steps = collapseSteps(events.data?.events ?? [], over);
  if (steps.length === 0) return null;
  return (
    <ol
      className="m-0 mt-2 flex list-none flex-col gap-1.5 p-0"
      aria-label={`Steps for version ${release.version}`}
    >
      {steps.map(({ step, state }) => {
        const color = STEP_COLOR[state];
        const Icon = state === 'failed' ? X : state === 'running' ? LoaderCircle : Check;
        return (
          <li key={step} className="flex items-center gap-2 text-[13px]">
            <span
              className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full"
              style={{ background: tint(color, 18), color }}
            >
              <Icon size={12} aria-hidden className={state === 'running' ? 'animate-spin' : ''} />
            </span>
            <span className={state === 'done' ? 'text-fg-muted' : 'font-medium text-fg-primary'}>
              {stepLabel(step, state)}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

export function RecentDeploys({
  projectId,
  env,
  releases,
  profiles,
}: {
  projectId: string;
  env: DeploymentEnvironment;
  releases: DeploymentReleaseSummary[];
  profiles: AgentProfile[];
}) {
  const [all, setAll] = useState(false);
  if (releases.length === 0) return null;
  const visible = all ? releases : releases.slice(0, SHOWN);
  return (
    <section id="deploys" className="flex scroll-mt-4 flex-col gap-3" aria-label="Recent deploys">
      <SectionTitle
        title="Recent deploys"
        hint="Every version agents shipped here, newest first."
      />
      <Panel className="overflow-hidden">
        <ol className="m-0 list-none p-0">
          {visible.map((release, index) => {
            const outcome = releaseOutcome(release, env);
            const who = profileNameOf(release.submittedBy?.agentProfileId, profiles) ?? 'Someone';
            // Steps for the newest version while it deploys or after it failed. A placement
            // failure never reached a server, so it has no steps to show.
            const showSteps =
              index === 0 &&
              (outcome.label === 'Deploying' ||
                (outcome.label === "Didn't start" && !placementFailed(env)));
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
                  {outcome.label === 'Skipped' && (
                    <span className="text-[13px] text-fg-muted">
                      A newer version arrived before a server picked this one up.
                    </span>
                  )}
                  {showSteps && (
                    <Steps
                      projectId={projectId}
                      env={env}
                      release={release}
                      over={outcome.label !== 'Deploying'}
                    />
                  )}
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
