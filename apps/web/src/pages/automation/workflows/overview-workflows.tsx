/**
 * Workflows on the Automation overview: runs that need attention join "Needs your attention",
 * and a Workflows panel shows the newest runs with a link to all of them.
 *
 * A run that needs attention stays in "Needs your attention" for the same window as a failed
 * one-time automation (`AUTOMATION_ATTENTION_WINDOW_MS`); there is no "mark as handled", and
 * the run keeps its state on the Workflows page after that.
 */
import type { WorkflowRunSummary } from '@simple-agent-manager/shared';
import { ChevronRight, TriangleAlert, Workflow } from 'lucide-react';
import { Link } from 'react-router';

import {
  AUTOMATION_ATTENTION_WINDOW_MS,
  AUTOMATION_PREVIEW_ROWS,
} from '../../../lib/automation-config';
import { automationPaths } from '../../../lib/automation-routes';
import { useProjectContext } from '../../ProjectContext';
import { Panel, RowLink, SectionTitle, TextLink } from '../ui';
import { useRecentWorkflowRuns } from './data';
import { attentionStep, runHeadline } from './model';
import { WorkflowRunRow } from './WorkflowRuns';

const withinWindow = (run: WorkflowRunSummary, now: number) =>
  now - Date.parse(run.updatedAt) <= AUTOMATION_ATTENTION_WINDOW_MS;

/**
 * Runs for the overview: the newest few for the Workflows panel, and the newest that ended
 * needing attention within the window. The newest few refresh while a run is going, so a run
 * that just failed shows up at once; the status read covers older ones. `moreAttention` says the
 * capped read left some out, so the overview links to them instead of hiding them (rule 65).
 */
export function useOverviewWorkflows(projectId: string, now = Date.now()) {
  const recent = useRecentWorkflowRuns(projectId, AUTOMATION_PREVIEW_ROWS);
  const flagged = useRecentWorkflowRuns(projectId, AUTOMATION_PREVIEW_ROWS, 'needs_attention');
  const runs = recent.data?.runs ?? [];
  const flaggedRuns = flagged.data?.runs ?? [];
  const byId = new Map<string, WorkflowRunSummary>();
  for (const run of [...flaggedRuns, ...runs])
    if (run.status === 'needs_attention' && withinWindow(run, now)) byId.set(run.id, run);
  const attention = [...byId.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const last = flaggedRuns.at(-1);
  const moreAttention = Boolean(flagged.data?.nextCursor && last && withinWindow(last, now));
  return { recent, runs, attention, moreAttention };
}

/** A link to the rest when more runs need attention than the overview shows. */
export function MoreWorkflowAttention() {
  const { projectId } = useProjectContext();
  return (
    <TextLink to={automationPaths.workflows(projectId, 'needs_attention')}>
      More workflows need attention
    </TextLink>
  );
}

/** One run in "Needs your attention": what failed, and a button to see it. */
export function WorkflowAttentionPanel({ run }: { run: WorkflowRunSummary }) {
  const { projectId } = useProjectContext();
  const step = attentionStep(run.steps);
  const to = automationPaths.workflow(projectId, run.id, step ? { step: step.key } : {});
  return (
    <Panel tone="warning" className="p-4" label={run.title}>
      <div className="flex gap-3" data-testid="workflow-attention-panel">
        <TriangleAlert size={20} aria-hidden className="mt-0.5 shrink-0 text-warning-fg" />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <Link
            to={automationPaths.workflow(projectId, run.id)}
            className="-ml-1 -mt-2.5 inline-flex min-h-11 w-fit max-w-full items-center gap-1 rounded-md px-1 text-[13px] font-medium text-fg-muted no-underline hover:text-fg-primary"
          >
            <Workflow size={14} aria-hidden className="shrink-0" />
            <span className="truncate">{run.title}</span>
            <ChevronRight size={14} aria-hidden className="shrink-0" />
          </Link>
          <p className="m-0 -mt-1.5 break-words text-[15px] font-semibold text-fg-primary [overflow-wrap:anywhere]">
            {runHeadline(run)}
          </p>
          {step?.reason && (
            <p className="m-0 line-clamp-3 break-words text-sm text-fg-muted [overflow-wrap:anywhere]">
              {step.reason}
            </p>
          )}
          <div className="mt-2 flex flex-wrap gap-3">
            <Link
              to={to}
              className="inline-flex min-h-11 items-center rounded-md bg-accent px-4 text-[0.95rem] font-semibold text-fg-on-accent no-underline"
            >
              See what went wrong
            </Link>
          </div>
        </div>
      </div>
    </Panel>
  );
}

/** The newest runs and a way to all of them; one quiet row when there are none yet. */
export function WorkflowsPanel({
  runs,
  isPending,
  isError,
  personName,
}: {
  runs: WorkflowRunSummary[];
  isPending: boolean;
  isError: boolean;
  personName: (userId: string) => string;
}) {
  const { projectId } = useProjectContext();
  const all = automationPaths.workflows(projectId);
  return (
    <div className="flex flex-col gap-2" data-testid="automation-workflows">
      <SectionTitle
        title="Workflows"
        hint="Multi-step work agents planned"
        action={runs.length ? <TextLink to={all}>All</TextLink> : undefined}
      />
      <Panel className="overflow-hidden" label="Workflows">
        {isPending ? (
          <p className="m-0 p-4 text-sm text-fg-muted">Loading workflows…</p>
        ) : runs.length ? (
          runs.map((run) => <WorkflowRunRow key={run.id} run={run} personName={personName} />)
        ) : (
          <RowLink
            to={all}
            leading={
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-surface-hover text-fg-muted">
                <Workflow size={18} aria-hidden />
              </span>
            }
            title={isError ? 'Could not load workflows' : 'No workflows yet'}
            subtitle={
              isError
                ? 'Open the Workflows page to try again'
                : 'Ask an agent to plan multi-step work as a workflow'
            }
          />
        )}
      </Panel>
    </div>
  );
}
