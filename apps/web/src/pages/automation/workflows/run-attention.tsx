/**
 * The callout at the top of a run that is in trouble: which step failed and why (the engine's
 * own words), what did not start because of it, and what can actually be done. SAM never retries
 * a failed step, so the honest next steps are reading that step's chat and asking an agent for a
 * new run; no retry button is offered because none exists.
 */
import type { WorkflowRunDetail } from '@simple-agent-manager/shared';
import { Button } from '@simple-agent-manager/ui';
import { TriangleAlert } from 'lucide-react';

import { projectChatPath } from '../../../lib/automation-routes';
import { ButtonLink, Panel } from '../ui';
import { attentionStep } from './model';

export function RunAttention({
  run,
  projectId,
  onSelect,
}: {
  run: WorkflowRunDetail;
  projectId: string;
  onSelect: (key: string) => void;
}) {
  if (run.status === 'completed') return null;
  const step = attentionStep(run.steps);
  const failed = step?.status === 'failed' ? step : null;
  if (run.status === 'active' && !failed) return null;

  const blocked = run.steps.filter((candidate) => candidate.status === 'blocked').length;
  const ended = run.status === 'needs_attention';
  const title = ended ? 'This workflow needs your attention' : `“${failed?.title ?? ''}” failed`;
  const starter = run.startedFrom?.sessionId;
  return (
    <Panel tone={ended ? 'warning' : 'danger'} className="p-4" label={title}>
      <div className="flex gap-3" data-testid="workflow-attention">
        <TriangleAlert
          size={20}
          aria-hidden
          className={`mt-0.5 shrink-0 ${ended ? 'text-warning-fg' : 'text-danger-fg'}`}
        />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <p className="m-0 break-words text-[15px] font-semibold text-fg-primary [overflow-wrap:anywhere]">
            {title}
          </p>
          {failed && (
            <p className="m-0 break-words text-sm text-fg-primary [overflow-wrap:anywhere]">
              {ended && <span className="font-semibold">“{failed.title}” failed: </span>}
              {failed.reason ?? 'No reason was recorded.'}
            </p>
          )}
          {!step && (
            <p className="m-0 text-sm text-fg-primary">It stopped before every step finished.</p>
          )}
          {blocked > 0 && (
            <p className="m-0 text-sm text-fg-muted">
              {blocked} {blocked === 1 ? 'step' : 'steps'} did not start because an earlier step did
              not succeed.
            </p>
          )}
          <p className="m-0 text-sm text-fg-muted">
            {ended
              ? 'SAM does not retry failed steps. To try again, ask an agent to start a new run.'
              : 'Steps that need it will not start. Steps that do not need it keep going.'}
          </p>
          <div className="mt-2 flex flex-wrap gap-3">
            {step && (
              <Button onClick={() => onSelect(step.key)}>
                {failed ? 'See the failed step' : 'See the step'}
              </Button>
            )}
            {failed?.sessionId && (
              <ButtonLink to={projectChatPath(projectId, failed.sessionId)}>
                Open its chat
              </ButtonLink>
            )}
            {ended && starter && (
              <ButtonLink to={projectChatPath(projectId, starter)}>
                Open the chat that started it
              </ButtonLink>
            )}
          </div>
        </div>
      </div>
    </Panel>
  );
}
