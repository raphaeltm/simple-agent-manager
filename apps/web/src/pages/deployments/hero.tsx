/**
 * The top of an environment page: its name and status in one sentence, the address with
 * Open app and Logs, who shipped the running version, and the one action that matters most.
 */
import { Button, buttonClassName } from '@simple-agent-manager/ui';
import { ExternalLink, ScrollText, Sparkles } from 'lucide-react';

import { Panel } from '../../components/page-kit/ui';
import type { DeploymentEnvironment, DeploymentReleaseSummary } from '../../lib/api';
import { ago, tint, TONE_COLOR } from './format';
import { type HealthInfo, isAnswering, versionOnStart } from './model';
import { AddressLine, AgentAvatar, ChatLink, EnvTitle, HealthMark } from './shared';

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
  if (info.health === 'paused')
    return canStart ? <Button onClick={onStart}>Start again</Button> : null;
  // A problem card below already offers the fix (or "Let agents deploy here…"); don't repeat it.
  if (info.health === 'down' && hasProblems) return null;
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

export function Hero({
  env,
  info,
  hostname,
  extraAddresses,
  projectId,
  credit,
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
  /** The release the status sentence is about: the live one, else the newest. */
  credit: DeploymentReleaseSummary | null;
  profileName: string | null;
  agentsOn: boolean;
  hasProblems: boolean;
  onLogs: () => void;
  onStart: () => void;
  onAsk: () => void;
  onAllowAgents: () => void;
}) {
  const color = TONE_COLOR[info.tone];
  const release = credit;
  const answering = isAnswering(info.health);
  // Logs come from a running server; without one there are none to show.
  const showLogs = Boolean(env.latestRelease) && env.node?.status === 'running';
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
                {info.health === 'paused'
                  ? 'Answers again when you start it.'
                  : 'Not answering right now.'}
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
