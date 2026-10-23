/**
 * PROTOTYPE Take A footer: pause (or start) and delete, at the bottom of the page.
 */
import { Button } from '@simple-agent-manager/ui';

import type { DeploymentEnvironment } from '../../../lib/api';
import { Panel, SectionTitle } from '../../automation/ui';

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
  return (
    <section id="pause" className="flex scroll-mt-4 flex-col gap-3" aria-label="Pause or delete">
      <SectionTitle title={paused ? 'Start or delete' : 'Pause or delete'} />
      <Panel className="overflow-hidden">
        <div className="flex flex-col gap-3 border-0 border-b border-solid border-border-default p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="text-[15px] font-semibold text-fg-primary">{paused ? 'Start again' : 'Pause'}</span>
            <span className="text-[13px] text-fg-muted">
              {paused
                ? env.latestRelease
                  ? `Puts version ${env.latestRelease.version} back on a server with its saved data. Takes a few minutes.`
                  : 'Nothing to start yet: no version has been deployed here.'
                : 'Stops the app. Its server is removed when nothing else runs on it. Settings, domains and disks are kept.'}
            </span>
          </div>
          <Button
            variant="secondary"
            className="shrink-0"
            disabled={changing || (paused && !env.latestRelease)}
            onClick={paused ? onStart : onPause}
          >
            {paused ? 'Start' : 'Pause'}
          </Button>
        </div>
        <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="text-[15px] font-semibold text-fg-primary">Delete this environment</span>
            <span className="text-[13px] text-fg-muted">Removes the app, its domains and its saved data. Can't be undone.</span>
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
