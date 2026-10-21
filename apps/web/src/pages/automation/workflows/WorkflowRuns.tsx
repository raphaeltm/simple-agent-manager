/**
 * Automation → Workflows: every workflow run in the project, problems first.
 *
 * Runs are started by agents (MCP `start_workflow_run`), so there is no "new" button; the empty
 * state says how to ask for one. There are no run controls either: the engine has no pause,
 * retry or cancel, and each step's chat keeps its own controls.
 */
import type { WorkflowRunSummary } from '@simple-agent-manager/shared';
import { Button } from '@simple-agent-manager/ui';
import { ChevronRight, Workflow } from 'lucide-react';
import { Link, useSearchParams } from 'react-router';

import {
  automationPaths,
  isWorkflowFilter,
  type WorkflowFilter,
} from '../../../lib/automation-routes';
import { formatTimeFromNow } from '../../../lib/time-utils';
import { useProjectContext } from '../../ProjectContext';
import { useAutomationAccess } from '../data';
import { LoadError, Loading, Page, PageHeader } from '../page';
import { Chips, Panel, SectionTitle } from '../ui';
import { useWorkflowRuns } from './data';
import { runHeadline } from './model';
import { RunBadge, RunTile, StepProgressBar } from './ui';

const FILTER_OPTIONS: Array<{ id: WorkflowFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'active', label: 'Running' },
  { id: 'needs_attention', label: 'Needs attention' },
  { id: 'completed', label: 'Done' },
];

const GROUPS: Array<{ status: WorkflowRunSummary['status']; title: string }> = [
  { status: 'needs_attention', title: 'Needs your attention' },
  { status: 'active', title: 'Running' },
  { status: 'completed', title: 'Done' },
];

/** One run: what it is, what is happening now, who started it, and its progress. */
export function WorkflowRunRow({
  run,
  personName,
}: {
  run: WorkflowRunSummary;
  personName: (userId: string) => string;
}) {
  const { projectId } = useProjectContext();
  const started = Date.parse(run.createdAt);
  const who = personName(run.startedByUserId);
  return (
    <Link
      to={automationPaths.workflow(projectId, run.id)}
      data-testid="workflow-run-row"
      className="group flex min-h-16 w-full min-w-0 items-center gap-3 border-0 border-b border-solid border-border-default bg-transparent px-4 py-3 text-left no-underline last:border-b-0 hover:bg-surface-hover"
    >
      <RunTile status={run.status} />
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="line-clamp-2 break-words text-[15px] font-semibold leading-snug text-fg-primary">
          {run.title}
        </span>
        <span className="line-clamp-2 break-words text-[13px] text-fg-muted">
          {runHeadline(run)}
        </span>
        <span className="pt-1">
          <StepProgressBar steps={run.steps} />
        </span>
        <span className="break-words text-xs text-fg-muted">
          Started by {who}
          {Number.isFinite(started) ? ` · ${formatTimeFromNow(started)}` : ''}
        </span>
        {run.status === 'needs_attention' && (
          // Under the text, not beside it: the overview shows these rows in a narrow column.
          <span className="mt-1 flex">
            <RunBadge status={run.status} />
          </span>
        )}
      </span>
      <ChevronRight
        size={18}
        aria-hidden
        className="shrink-0 text-fg-muted transition-transform group-hover:translate-x-0.5"
      />
    </Link>
  );
}

function EmptyWorkflows() {
  return (
    <Panel
      className="flex flex-col items-center gap-4 px-6 py-10 text-center"
      label="No workflows yet"
    >
      <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-[var(--sam-color-accent-primary-tint)] text-accent">
        <Workflow size={26} aria-hidden />
      </span>
      <div className="flex max-w-md flex-col gap-2">
        <h2 className="m-0 text-[19px] font-semibold text-fg-primary">No workflows yet</h2>
        <p className="m-0 text-[15px] text-fg-muted">
          A workflow is a plan of agent steps. SAM starts each step as soon as the steps it needs
          are done, and every step is a chat you can open.
        </p>
        <p className="m-0 text-[15px] text-fg-muted">
          Ask an agent in any chat, for example: “Plan this as a workflow: draft the release notes,
          have them reviewed, then apply the review.”
        </p>
      </div>
    </Panel>
  );
}

function RunList({
  runs,
  personName,
  label,
}: {
  runs: WorkflowRunSummary[];
  personName: (userId: string) => string;
  label: string;
}) {
  return (
    <Panel className="overflow-hidden" label={label}>
      {runs.map((run) => (
        <WorkflowRunRow key={run.id} run={run} personName={personName} />
      ))}
    </Panel>
  );
}

export function WorkflowRuns() {
  const { projectId } = useProjectContext();
  const { personName } = useAutomationAccess();
  const [params, setParams] = useSearchParams();
  const statusParam = params.get('status');
  const filter: WorkflowFilter = isWorkflowFilter(statusParam) ? statusParam : 'all';
  const { query, runs } = useWorkflowRuns(projectId, filter);

  const header = (
    <PageHeader
      back={{ label: 'Automation', to: automationPaths.overview(projectId) }}
      title="Workflows"
      subtitle="Multi-step work an agent planned. SAM starts each step as soon as the steps it needs are done."
    />
  );
  const chips = (
    <Chips
      label="Show"
      value={filter}
      options={FILTER_OPTIONS}
      onChange={(next) =>
        setParams(
          (previous) => {
            const updated = new URLSearchParams(previous);
            if (next === 'all') updated.delete('status');
            else updated.set('status', next);
            return updated;
          },
          { replace: true }
        )
      }
    />
  );

  if (query.isPending) {
    return (
      <Page>
        {header}
        <Loading label="Loading workflows…" />
      </Page>
    );
  }

  const failed = query.isError ? (
    <LoadError what="workflows" error={query.error} onRetry={() => void query.refetch()} />
  ) : null;

  if (!runs.length) {
    return (
      <Page>
        {header}
        {failed}
        {filter === 'all' && !failed ? (
          <EmptyWorkflows />
        ) : (
          <>
            {chips}
            {!failed && (
              <p className="m-0 rounded-xl border border-dashed border-border-default p-4 text-sm text-fg-muted">
                Nothing here right now.
              </p>
            )}
          </>
        )}
      </Page>
    );
  }

  const groups =
    filter === 'all'
      ? GROUPS.map((group) => ({
          ...group,
          runs: runs.filter((run) => run.status === group.status),
        })).filter((group) => group.runs.length > 0)
      : [{ status: filter, title: '', runs }];

  return (
    <Page>
      <div data-testid="workflow-runs" className="flex flex-col gap-6">
        {header}
        {failed}
        {chips}
        {groups.map((group) => (
          <div key={group.status} className="flex flex-col gap-2">
            {group.title && <SectionTitle title={group.title} count={group.runs.length} />}
            <RunList runs={group.runs} personName={personName} label={group.title || 'Workflows'} />
          </div>
        ))}
        {query.hasNextPage && (
          <Button
            variant="secondary"
            className="w-fit"
            loading={query.isFetchingNextPage}
            onClick={() => void query.fetchNextPage()}
          >
            Show older workflows
          </Button>
        )}
      </div>
    </Page>
  );
}
