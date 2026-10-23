/**
 * PROTOTYPE Take B release timeline: every version on one rail, newest first.
 *
 * The live version is the big card (what runs, Open, Logs). A deploy in progress shows the
 * steps the server reports. A failed deploy says what broke in words and offers the fix.
 * Older versions are one line each, with "Roll back".
 * NEEDS API: re-applying a past release has no route yet; the dialog only shows the flow.
 */
import type { AgentProfile } from '@simple-agent-manager/shared';
import { Button, buttonClassName, Dialog } from '@simple-agent-manager/ui';
import { Check, ChevronDown, ExternalLink, LoaderCircle, RotateCcw, ScrollText, Sparkles, X } from 'lucide-react';
import { useState } from 'react';

import { serviceRecords } from '../../../components/deployments/deployment-status';
import type { DeploymentEnvironment } from '../../../lib/api';
import { type ReleaseEvent, type ReleaseRecord, useReleaseEvents } from '../data';
import { ago, profileNameOf, releaseOutcome, type Tone, TONE_COLOR, tint } from '../model';
import { AgentAvatar, ChatLink, TonePill, useAskAgent } from '../shared';

/** Older versions shown as one-liners under the live one before "N older versions". */
const RECENT_ROWS = 4;

/** Each step in words: [done, in progress, failed]. */
const STEP_NAMES: Record<string, [string, string, string]> = {
  fetch: ['Got the new version', 'Getting the new version…', "Couldn't get the new version"],
  'compose-config': ['Checked the Compose file', 'Checking the Compose file…', 'The Compose file has a problem'],
  'artifact-load': ['Loaded the images', 'Loading the images…', "Couldn't load the images"],
  'compose-up': ['Started the containers', 'Starting the containers…', "Couldn't start the containers"],
  'health-check': ['Passed the health check', 'Checking the app answers…', 'Failed the health check'],
  'caddy-reload': ['Switched visitors over', 'Switching visitors over…', "Couldn't switch visitors over"],
  revert: ['Put the previous version back', 'Putting the previous version back…', "Couldn't put the previous version back"],
};

function stepState(event: ReleaseEvent): 'done' | 'running' | 'failed' {
  if (event.level === 'error') return 'failed';
  if (event.eventType.endsWith('started')) return 'running';
  return 'done';
}

function Steps({ events }: { events: ReleaseEvent[] }) {
  const steps = events.filter((event) => event.step && STEP_NAMES[event.step]);
  if (steps.length === 0) return null;
  return (
    <ol className="m-0 flex list-none flex-col gap-1.5 p-0">
      {steps.map((event) => {
        const state = stepState(event);
        const color =
          state === 'failed'
            ? 'var(--sam-color-danger-fg)'
            : state === 'running'
              ? 'var(--sam-color-info-fg)'
              : 'var(--sam-color-success-fg)';
        const Icon = state === 'failed' ? X : state === 'running' ? LoaderCircle : Check;
        return (
          <li key={event.seq} className="flex items-center gap-2 text-[13px]">
            <span
              className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full"
              style={{ background: tint(color, 18), color }}
            >
              <Icon size={12} aria-hidden className={state === 'running' ? 'animate-spin' : ''} />
            </span>
            <span className={state === 'done' ? 'text-fg-muted' : 'font-medium text-fg-primary'}>
              {STEP_NAMES[event.step ?? '']?.[state === 'done' ? 0 : state === 'running' ? 1 : 2]}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function Who({
  projectId,
  release,
  profiles,
}: {
  projectId: string;
  release: ReleaseRecord;
  profiles: AgentProfile[];
}) {
  const name = profileNameOf(release.submittedBy?.agentProfileId, profiles) ?? 'Someone';
  return (
    <span className="flex min-w-0 items-start gap-2 text-[13px] text-fg-muted">
      <AgentAvatar name={name} size={24} />
      <span className="min-w-0 pt-0.5">
        <span className="font-semibold text-fg-primary">{name}</span>, {ago(release.createdAt)}
        {release.submittedBy?.taskId && (
          <>
            {' · from '}
            <ChatLink projectId={projectId} taskId={release.submittedBy.taskId} />
          </>
        )}
      </span>
    </span>
  );
}

function Node({ tone, big, children }: { tone: Tone; big?: boolean; children: React.ReactNode }) {
  const color = TONE_COLOR[tone];
  return (
    <li className="relative flex gap-4 pb-5 last:pb-0">
      <span className="relative z-[1] flex w-6 shrink-0 justify-center pt-1">
        <span
          aria-hidden
          className="block rounded-full"
          style={{
            width: big ? 14 : 10,
            height: big ? 14 : 10,
            background: color,
            boxShadow: `0 0 0 4px ${tint(color, 22)}`,
          }}
        />
      </span>
      <div className="min-w-0 flex-1">{children}</div>
    </li>
  );
}

function ServiceChips({ env }: { env: DeploymentEnvironment }) {
  const services = serviceRecords(env.observedDeployment.services);
  if (services.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {services.map((service) => {
        const healthy = service.status === 'running' && (!service.health || service.health === 'healthy' || service.health === 'none');
        const color = healthy ? 'var(--sam-color-success-fg)' : 'var(--sam-color-warning-fg)';
        return (
          <span
            key={String(service.name)}
            className="inline-flex items-center gap-1.5 rounded-full border border-border-default px-2.5 py-1 font-mono text-[12px] text-fg-primary"
          >
            <span aria-hidden className="h-1.5 w-1.5 rounded-full" style={{ background: color }} />
            {String(service.name)}
          </span>
        );
      })}
    </div>
  );
}

export function ReleaseTimeline({
  projectId,
  env,
  releases,
  liveVersion,
  pausedVersion,
  profiles,
  liveAddress,
  onLogs,
}: {
  projectId: string;
  env: DeploymentEnvironment;
  releases: ReleaseRecord[];
  liveVersion: number | null;
  pausedVersion: number | null;
  profiles: AgentProfile[];
  liveAddress: string | null;
  onLogs: (filter: 'all' | 'errors') => void;
}) {
  const askAgent = useAskAgent(projectId);
  const [older, setOlder] = useState(false);
  const [rollback, setRollback] = useState<ReleaseRecord | null>(null);
  const newest = releases[0];
  const events = useReleaseEvents(projectId, env.id, newest?.id, Boolean(newest) && newest?.version !== liveVersion);
  const liveIndex = releases.findIndex((release) => release.version === (liveVersion ?? pausedVersion));
  // Everything down to the live version is expanded, then a few older versions as one-liners;
  // the rest of the history folds away.
  const headCount = Math.max(liveIndex + 1, 1);
  const head = releases.slice(0, headCount);
  const recent = releases.slice(headCount, headCount + RECENT_ROWS);
  const tail = releases.slice(headCount + RECENT_ROWS);

  if (releases.length === 0) {
    return (
      <p className="m-0 rounded-xl bg-surface-hover px-4 py-6 text-center text-sm text-fg-muted">
        No versions yet. When an agent deploys here, every version it ships shows up on this timeline.
      </p>
    );
  }

  const renderCompact = (release: ReleaseRecord) => {
    const outcome = releaseOutcome(release, liveVersion, pausedVersion);
    return (
      <Node key={release.id} tone={outcome.tone === 'danger' ? 'danger' : 'muted'}>
        <div className="flex min-w-0 flex-col gap-1 sm:flex-row sm:items-start sm:justify-between sm:gap-3">
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-[14px] font-semibold text-fg-primary">v{release.version}</span>
              {outcome.label !== 'Replaced' && <TonePill tone={outcome.tone} label={outcome.label} />}
            </span>
            <Who projectId={projectId} release={release} profiles={profiles} />
          </div>
          {release.status === 'applied' && liveVersion !== null && (
            <button
              type="button"
              onClick={() => setRollback(release)}
              className="inline-flex min-h-11 w-fit shrink-0 cursor-pointer items-center gap-1.5 rounded-md border-0 bg-transparent px-2 text-[13px] font-semibold text-fg-muted hover:bg-surface-hover hover:text-fg-primary"
            >
              <RotateCcw size={14} aria-hidden /> Roll back to this
            </button>
          )}
        </div>
      </Node>
    );
  };

  return (
    <div className="relative">
      <span aria-hidden className="absolute bottom-3 left-3 top-3 w-px -translate-x-1/2 bg-border-default" />
      <ol className="m-0 list-none p-0">
        {head.map((release) => {
          const outcome = releaseOutcome(release, liveVersion, pausedVersion);
          if (outcome.label === 'Live' || outcome.label === 'Paused') {
            return (
              <Node key={release.id} tone={outcome.tone} big>
                <div
                  className="flex flex-col gap-3 rounded-xl border p-4"
                  style={{ borderColor: tint(TONE_COLOR[outcome.tone], 45), background: tint(TONE_COLOR[outcome.tone], 7) }}
                >
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="text-[12px] font-bold uppercase tracking-wide" style={{ color: TONE_COLOR[outcome.tone] }}>
                      {outcome.label === 'Live' ? 'Live now' : 'Comes back on start'}
                    </span>
                    <span className="font-mono text-[18px] font-bold text-fg-primary">v{release.version}</span>
                  </span>
                  <Who projectId={projectId} release={release} profiles={profiles} />
                  {outcome.label === 'Live' && <ServiceChips env={env} />}
                  {outcome.label === 'Live' && (
                    <div className="flex flex-wrap gap-2">
                      {liveAddress && (
                        <a
                          href={`https://${liveAddress}`}
                          target="_blank"
                          rel="noreferrer"
                          className={`${buttonClassName({ variant: 'primary' })} no-underline`}
                        >
                          Open app <ExternalLink size={16} aria-hidden />
                        </a>
                      )}
                      <Button variant="secondary" onClick={() => onLogs('all')}>
                        <ScrollText size={16} aria-hidden /> Logs
                      </Button>
                    </div>
                  )}
                </div>
              </Node>
            );
          }
          if (outcome.label === "Didn't start") {
            const detail = release.id === env.latestRelease?.id ? env.observedDeployment.errorMessage : null;
            return (
              <Node key={release.id} tone="danger">
                <div className="flex flex-col gap-2 rounded-xl border border-danger/35 bg-danger-tint p-4">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-[15px] font-bold text-fg-primary">v{release.version}</span>
                    <TonePill tone="danger" label="Didn't start" />
                  </span>
                  <Who projectId={projectId} release={release} profiles={profiles} />
                  <p className="m-0 text-sm text-fg-primary">
                    {liveVersion ? `Visitors still get v${liveVersion}. ` : 'Nothing is live yet. '}
                    Fix the problem and deploy again.
                  </p>
                  {release.id === newest?.id && <Steps events={events.data?.events ?? []} />}
                  {detail && (
                    <details className="group">
                      <summary className="inline-flex min-h-11 cursor-pointer list-none items-center gap-1 text-[13px] font-semibold text-fg-muted hover:text-fg-primary [&::-webkit-details-marker]:hidden">
                        What the server said
                        <ChevronDown size={14} aria-hidden className="transition-transform group-open:rotate-180" />
                      </summary>
                      <pre className="m-0 whitespace-pre-wrap break-words rounded-lg bg-inset p-3 font-mono text-[12px] text-fg-primary [overflow-wrap:anywhere]">
                        {detail}
                      </pre>
                    </details>
                  )}
                  {release.id === newest?.id && (
                    <div className="flex flex-wrap gap-2">
                      <Button variant="secondary" onClick={() => askAgent(`v${release.version} didn't start`)}>
                        <Sparkles size={16} aria-hidden /> Ask an agent to fix it
                      </Button>
                      <Button variant="ghost" onClick={() => onLogs('errors')}>
                        <ScrollText size={16} aria-hidden /> Logs
                      </Button>
                    </div>
                  )}
                </div>
              </Node>
            );
          }
          if (outcome.label === 'Deploying') {
            return (
              <Node key={release.id} tone="info">
                <div className="flex flex-col gap-3 rounded-xl border border-border-default p-4" style={{ background: tint(TONE_COLOR.info, 7) }}>
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-[15px] font-bold text-fg-primary">v{release.version}</span>
                    <TonePill tone="info" label="Deploying" />
                  </span>
                  <Who projectId={projectId} release={release} profiles={profiles} />
                  <Steps events={events.data?.events ?? []} />
                  {liveVersion && (
                    <p className="m-0 text-[13px] text-fg-muted">v{liveVersion} stays live until this one is ready.</p>
                  )}
                </div>
              </Node>
            );
          }
          return renderCompact(release);
        })}
        {recent.map(renderCompact)}
        {older && tail.map(renderCompact)}
      </ol>
      {tail.length > 0 && (
        <Button variant="ghost" className="ml-8 mt-2" onClick={() => setOlder((value) => !value)}>
          {older ? 'Hide older versions' : `${tail.length} older ${tail.length === 1 ? 'version' : 'versions'}`}
        </Button>
      )}
      <Dialog isOpen={rollback !== null} onClose={() => setRollback(null)} aria-label="Roll back">
        {rollback && (
          <div className="flex flex-col gap-4">
            <h2 className="m-0 text-[19px] font-semibold text-fg-primary">Roll back to v{rollback.version}?</h2>
            <p className="m-0 text-[15px] text-fg-primary">
              Version {rollback.version} goes live again with today's settings and data. v{liveVersion} stays in the
              history, so you can come back to it.
            </p>
            <div className="flex flex-wrap justify-end gap-3">
              <Button variant="ghost" onClick={() => setRollback(null)}>
                Cancel
              </Button>
              <Button onClick={() => setRollback(null)}>
                <RotateCcw size={16} aria-hidden /> Roll back
              </Button>
            </div>
          </div>
        )}
      </Dialog>
    </div>
  );
}
