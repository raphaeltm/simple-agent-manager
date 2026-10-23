/**
 * "Needs your attention": each problem in words, its raw error on request, and its fixes.
 */
import { Button } from '@simple-agent-manager/ui';
import { ChevronDown, CircleAlert, Sparkles, TriangleAlert } from 'lucide-react';

import { Panel, SectionTitle } from '../automation/ui';
import { ASKS_AGENT, type Fix, type Problem } from './model';

const FIX_LABEL: Record<Fix, string> = {
  'ask-agent': 'Ask an agent to fix it',
  redeploy: 'Ask an agent to deploy again',
  logs: 'See logs',
  server: 'See the server',
  domains: 'Check domains',
  start: 'Start again',
  pause: 'Pause again',
  access: 'Let agents deploy here…',
};

export function ProblemList({
  problems,
  canAskAgent,
  onFix,
}: {
  problems: Problem[];
  /** False while agents may not deploy here: the fix becomes "let agents deploy" first. */
  canAskAgent: boolean;
  onFix: (fix: Fix, problem: Problem) => void;
}) {
  if (problems.length === 0) return null;
  return (
    <section
      id="problems"
      className="flex scroll-mt-4 flex-col gap-3"
      aria-label="Needs your attention"
    >
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
                      <ChevronDown
                        size={14}
                        aria-hidden
                        className="transition-transform group-open:rotate-180"
                      />
                    </summary>
                    <pre className="m-0 whitespace-pre-wrap break-words rounded-lg bg-inset p-3 font-mono text-[12px] text-fg-primary [overflow-wrap:anywhere]">
                      {problem.detail}
                    </pre>
                  </details>
                )}
                <div className="mt-2 flex flex-wrap gap-3">
                  {problem.fixes
                    .map((fix) => (canAskAgent || !ASKS_AGENT.has(fix) ? fix : 'access'))
                    .map((fix) => (
                      <Button key={fix} variant="secondary" onClick={() => onFix(fix, problem)}>
                        {ASKS_AGENT.has(fix) && <Sparkles size={16} aria-hidden />}
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
