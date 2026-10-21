/**
 * The run's lifecycle, oldest first, in plain words: what started, finished, failed or did not
 * start, and when. These are SAM's own records (`mission_workflow_events`), not agent output.
 */
import type { WorkflowRunDetail } from '@simple-agent-manager/shared';

import { formatTimeFromNow } from '../../../lib/time-utils';
import { dateTimeLabel } from '../time';
import { Panel } from '../ui';
import { activityText, activityTone } from './model';
import { TONE_COLOR } from './ui';

export function RunActivity({
  run,
  onSelect,
}: {
  run: WorkflowRunDetail;
  onSelect: (key: string) => void;
}) {
  const byKey = new Map(run.steps.map((step) => [step.key, step]));
  const titleOf = (key: string) => byKey.get(key)?.title ?? key;
  const kindOf = (key: string) => byKey.get(key)?.kind;
  if (!run.activity.length)
    return <p className="m-0 p-4 text-sm text-fg-muted">Nothing has happened yet.</p>;
  return (
    <Panel className="overflow-hidden" label="Activity">
      <ol className="m-0 list-none p-0" data-testid="workflow-activity">
        {run.activity.map((entry, index) => {
          const at = Date.parse(entry.at);
          const text = activityText(entry, titleOf, kindOf);
          const stepKey = entry.stepKey;
          const body = (
            <>
              <span
                aria-hidden
                className="mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full"
                style={{ background: TONE_COLOR[activityTone(entry.state)] }}
              />
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="break-words text-sm text-fg-primary [overflow-wrap:anywhere]">
                  {text}
                </span>
                {Number.isFinite(at) && (
                  <span className="text-xs text-fg-muted">
                    {dateTimeLabel(at)} · {formatTimeFromNow(at)}
                  </span>
                )}
              </span>
            </>
          );
          return (
            <li
              key={`${entry.at}:${entry.stepKey ?? 'run'}:${entry.state}:${index}`}
              className="border-0 border-b border-solid border-border-default last:border-b-0"
            >
              {stepKey && byKey.has(stepKey) ? (
                <button
                  type="button"
                  onClick={() => onSelect(stepKey)}
                  className="flex min-h-14 w-full cursor-pointer items-start gap-3 border-0 bg-transparent px-4 py-3 text-left hover:bg-surface-hover"
                >
                  {body}
                </button>
              ) : (
                <div className="flex min-h-14 items-start gap-3 px-4 py-3">{body}</div>
              )}
            </li>
          );
        })}
      </ol>
    </Panel>
  );
}
