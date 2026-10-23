/**
 * The environment page footer: pause (or start) and delete, at the very bottom.
 */
import { Button } from '@simple-agent-manager/ui';

import type { DeploymentEnvironment } from '../../lib/api';
import { Panel, SectionTitle } from '../automation/ui';
import { describeHealth, failureKind, liveVersionOf } from './model';

/** What Pause does, said for what is actually running. */
function pauseSentence(env: DeploymentEnvironment): string {
  if (failureKind(env) === 'pause')
    return "The last pause didn't finish. Pausing again finishes stopping the app and detaching its disks.";
  const kept = 'Settings, domains and disks are kept.';
  // A deploy in progress has nothing up for a moment, but Pause still stops it.
  const inMotion = env.status === 'starting' || describeHealth(env).health === 'deploying';
  if (liveVersionOf(env) === null && !inMotion) {
    return env.nodeId
      ? `Nothing is running. Pausing frees its server. ${kept}`
      : `Nothing is running. Pausing keeps it ready to start later. ${kept}`;
  }
  return `Stops the app. Its server is removed when nothing else runs on it. ${kept}`;
}

export function PauseOrDelete({
  env,
  onPause,
  onStart,
  onDelete,
}: {
  env: DeploymentEnvironment;
  onPause: () => void;
  onStart: () => void;
  onDelete: () => void;
}) {
  const paused = env.status === 'stopped';
  const changing = env.status === 'starting' || env.status === 'stopping';
  // Nothing was ever deployed: there is nothing to pause or start, only to delete.
  const neverDeployed = !env.latestRelease && !paused;
  const title = neverDeployed ? 'Delete' : paused ? 'Start or delete' : 'Pause or delete';
  return (
    <section id="pause" className="flex scroll-mt-4 flex-col gap-3" aria-label={title}>
      <SectionTitle title={title} />
      <Panel className="overflow-hidden">
        {!neverDeployed && (
          <div className="flex flex-col gap-3 border-0 border-b border-solid border-border-default p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="text-[15px] font-semibold text-fg-primary">
                {paused ? 'Start again' : 'Pause'}
              </span>
              <span className="text-[13px] text-fg-muted">
                {paused
                  ? env.latestRelease
                    ? `Puts version ${env.latestRelease.version} back on a server with its saved data. Takes a few minutes.`
                    : 'Nothing to start yet: no version has been deployed here.'
                  : pauseSentence(env)}
              </span>
            </div>
            <Button
              variant="secondary"
              className="shrink-0"
              disabled={changing || (paused && !env.latestRelease)}
              onClick={paused ? onStart : onPause}
            >
              {paused ? 'Start' : failureKind(env) === 'pause' ? 'Pause again' : 'Pause'}
            </Button>
          </div>
        )}
        <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="text-[15px] font-semibold text-fg-primary">
              Delete this environment
            </span>
            <span className="text-[13px] text-fg-muted">
              Removes the app, its domains and its saved data. Can’t be undone.
            </span>
          </div>
          <button
            type="button"
            disabled={changing}
            onClick={onDelete}
            className="inline-flex min-h-11 shrink-0 cursor-pointer items-center justify-center rounded-md border border-solid border-[color-mix(in_srgb,var(--sam-color-danger-fg)_45%,transparent)] bg-transparent px-4 text-[0.95rem] font-semibold text-danger-fg hover:bg-danger-tint disabled:cursor-not-allowed disabled:opacity-50"
          >
            Delete…
          </button>
        </div>
      </Panel>
    </section>
  );
}
