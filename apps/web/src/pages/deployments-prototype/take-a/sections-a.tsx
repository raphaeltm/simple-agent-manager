/**
 * PROTOTYPE Take A detail sections: problems and recent deploys.
 */
import type { AgentProfile } from '@simple-agent-manager/shared';
import { Button } from '@simple-agent-manager/ui';
import { ChevronDown, CircleAlert, Sparkles, TriangleAlert } from 'lucide-react';
import { useState } from 'react';

import { Panel, SectionTitle } from '../../automation/ui';
import type { ReleaseRecord } from '../data';
import { type Fix, type Problem, ago, profileNameOf, releaseOutcome } from '../model';
import { AgentAvatar, ChatLink, TonePill } from '../shared';

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
