/**
 * One workflow run: progress, what needs attention, and every step as a checklist, a dependency
 * graph or a timeline. Selecting a step shows it in full: beside the steps on wide screens, in
 * place of them on phones (the browser's back button returns to the list).
 *
 * Read-only on purpose. The engine has no pause, retry, skip or cancel; each step's chat keeps
 * the controls it always had.
 */
import { ArrowLeft, History, ListChecks, Network } from 'lucide-react';
import { lazy, type ReactNode, Suspense, useCallback, useEffect, useRef } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router';

import { useMediaQuery } from '../../../hooks/useMediaQuery';
import { ApiClientError } from '../../../lib/api/client';
import {
  automationPaths,
  isWorkflowRunView,
  type WorkflowRunView,
} from '../../../lib/automation-routes';
import { formatTimeFromNow } from '../../../lib/time-utils';
import { useProjectContext } from '../../ProjectContext';
import { useAutomationAccess } from '../data';
import { LoadError, Loading, Page, PageHeader } from '../page';
import { useRadioKeys } from '../radio-keys';
import { Panel } from '../ui';
import { useWorkflowRun } from './data';
import { progressSentence, workflowProgress } from './model';
import { RunAbout } from './run-about';
import { RunActivity } from './run-activity';
import { RunAttention } from './run-attention';
import { RunSteps } from './run-steps';
import { StepDetail } from './step-detail';
import { RunBadge, StepProgressBar } from './ui';

const RunGraph = lazy(() => import('./run-graph').then((module) => ({ default: module.RunGraph })));

/** The width at which step details sit beside the steps (Tailwind `lg`). */
const WIDE_QUERY = '(min-width: 1024px)';

/** History state marking a step opened from the list on a phone. */
const FROM_LIST = 'workflowStepFromList';

const TABS: Array<{ id: WorkflowRunView; label: string; Icon: typeof ListChecks }> = [
  { id: 'steps', label: 'Steps', Icon: ListChecks },
  { id: 'graph', label: 'Graph', Icon: Network },
  { id: 'activity', label: 'Activity', Icon: History },
];

const TAB_PANEL_ID = 'workflow-run-view';
const tabId = (view: WorkflowRunView) => `workflow-run-tab-${view}`;

/** One tab stop; arrow keys, Home and End move between views (the WAI-ARIA tabs pattern). */
function Tabs({
  view,
  onChange,
}: {
  view: WorkflowRunView;
  onChange: (view: WorkflowRunView) => void;
}) {
  const keys = useRadioKeys(TABS, view, onChange);
  return (
    <div
      role="tablist"
      aria-label="Show the run as"
      className="flex gap-1 border-0 border-b border-solid border-border-default"
    >
      {TABS.map(({ id, label, Icon }, index) => {
        const active = id === view;
        return (
          <button
            key={id}
            {...keys(index)}
            id={tabId(id)}
            type="button"
            role="tab"
            aria-selected={active}
            aria-controls={TAB_PANEL_ID}
            onClick={() => onChange(id)}
            className={`-mb-px inline-flex min-h-11 cursor-pointer items-center gap-1.5 border-0 border-b-2 border-solid bg-transparent px-3 text-sm font-semibold ${active ? 'border-b-accent text-fg-primary' : 'border-b-transparent text-fg-muted hover:text-fg-primary'}`}
          >
            <Icon size={16} aria-hidden />
            {label}
          </button>
        );
      })}
    </div>
  );
}

function NotFound({ back }: { back: ReactNode }) {
  return (
    <Panel className="flex flex-col gap-2 p-4" label="Workflow run not found">
      <p className="m-0 text-[15px] font-semibold text-fg-primary">This workflow run is not here</p>
      <p className="m-0 text-sm text-fg-muted">
        The link may be wrong, or the run belongs to another project.
      </p>
      {back}
    </Panel>
  );
}

export function WorkflowRunPage() {
  const { projectId } = useProjectContext();
  const { runId = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const wide = useMediaQuery(WIDE_QUERY);
  const { personName } = useAutomationAccess();
  const query = useWorkflowRun(projectId, runId);
  const run = query.data;

  const viewParam = params.get('view');
  const view: WorkflowRunView = isWorkflowRunView(viewParam) ? viewParam : wide ? 'graph' : 'steps';
  const selectedKey = params.get('step');
  const selected = run?.steps.find((step) => step.key === selectedKey) ?? null;

  const setParam = useCallback(
    (name: 'view' | 'step', value: string | null, replace: boolean) =>
      setParams(
        (previous) => {
          const next = new URLSearchParams(previous);
          if (value === null) next.delete(name);
          else next.set(name, value);
          return next;
        },
        { replace }
      ),
    [setParams]
  );
  const location = useLocation();
  const navigate = useNavigate();
  // On phones the step replaces the list, so it gets its own history entry: the browser's Back
  // and "All steps" both return to the list.
  const select = useCallback(
    (key: string) =>
      setParams(
        (previous) => {
          const next = new URLSearchParams(previous);
          next.set('step', key);
          return next;
        },
        { replace: wide, state: wide ? undefined : { [FROM_LIST]: true } }
      ),
    [setParams, wide]
  );
  const openedFromList = Boolean(
    location.state && typeof location.state === 'object' && FROM_LIST in location.state
  );
  const clearSelection = useCallback(() => {
    if (!wide && openedFromList) navigate(-1);
    else setParam('step', null, true);
  }, [navigate, openedFromList, setParam, wide]);

  // A newly selected step starts at its top, wherever the page or side panel was scrolled.
  const detailRef = useRef<HTMLDivElement>(null);
  const asideRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!selectedKey) return;
    if (wide) {
      if (asideRef.current) asideRef.current.scrollTop = 0;
    } else {
      detailRef.current?.scrollIntoView?.({ block: 'start' });
    }
  }, [selectedKey, wide]);

  const backLink = { label: 'Workflows', to: automationPaths.workflows(projectId) };

  if (query.isPending) {
    return (
      <Page wide>
        <PageHeader back={backLink} title="Workflow" />
        <Loading label="Loading the workflow…" />
      </Page>
    );
  }

  if (!run) {
    const missing = query.error instanceof ApiClientError && query.error.status === 404;
    return (
      <Page wide>
        <PageHeader back={backLink} title="Workflow" />
        {missing ? (
          <NotFound
            back={
              <Link
                to={backLink.to}
                className="inline-flex min-h-11 w-fit items-center text-sm font-semibold text-accent"
              >
                See every workflow
              </Link>
            }
          />
        ) : (
          <LoadError
            what="this workflow"
            error={query.error}
            onRetry={() => void query.refetch()}
          />
        )}
      </Page>
    );
  }

  const progress = workflowProgress(run.steps);
  const started = Date.parse(run.createdAt);
  const tabContent =
    view === 'steps' ? (
      <RunSteps run={run} selectedKey={selectedKey} onSelect={select} sideBySide={wide} />
    ) : view === 'graph' ? (
      <Suspense fallback={<Loading label="Drawing the graph…" />}>
        <RunGraph run={run} selectedKey={selectedKey} onSelect={select} />
      </Suspense>
    ) : (
      <RunActivity run={run} onSelect={select} />
    );
  const about = <RunAbout run={run} projectId={projectId} personName={personName} />;

  return (
    <Page wide>
      <div data-testid="workflow-run" className="flex min-w-0 flex-col gap-5">
        <PageHeader
          back={backLink}
          title={run.title}
          subtitle={
            <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <RunBadge status={run.status} />
              <span className="break-words">
                Started by {personName(run.startedByUserId)}
                {Number.isFinite(started) ? ` · ${formatTimeFromNow(started)}` : ''}
              </span>
            </span>
          }
        />
        {query.isError && (
          <LoadError
            what="the latest changes"
            error={query.error}
            onRetry={() => void query.refetch()}
          />
        )}
        <div className="flex flex-col gap-2">
          <StepProgressBar steps={run.steps} height={8} />
          <p className="m-0 text-sm text-fg-muted" data-testid="workflow-progress-sentence">
            {progressSentence(progress, run.status)}
          </p>
        </div>
        <RunAttention run={run} projectId={projectId} onSelect={select} />

        {!wide && selected ? (
          <div ref={detailRef} className="flex scroll-mt-4 flex-col gap-4">
            <button
              type="button"
              onClick={clearSelection}
              className="-ml-2 inline-flex min-h-11 w-fit cursor-pointer items-center gap-1 rounded-md border-0 bg-transparent px-2 text-sm font-semibold text-fg-muted hover:text-fg-primary"
            >
              <ArrowLeft size={16} aria-hidden /> All steps
            </button>
            <StepDetail run={run} step={selected} projectId={projectId} onSelect={select} />
          </div>
        ) : (
          <div
            className={
              wide
                ? 'grid grid-cols-[minmax(0,1fr)_380px] items-start gap-8'
                : 'flex min-w-0 flex-col gap-6'
            }
          >
            <div className="flex min-w-0 flex-col gap-4">
              <Tabs view={view} onChange={(next) => setParam('view', next, true)} />
              <div
                role="tabpanel"
                id={TAB_PANEL_ID}
                aria-labelledby={tabId(view)}
                className="min-w-0"
              >
                {tabContent}
              </div>
            </div>
            {wide ? (
              // Sticky is positioned, so it is the containing block of everything it scrolls (rule 56).
              <aside
                ref={asideRef}
                aria-label={selected ? 'Step details' : 'About this run'}
                className="glass-surface sticky top-4 max-h-[calc(100dvh-2rem)] min-w-0 overflow-y-auto rounded-xl border border-solid border-border-default p-4"
              >
                {selected ? (
                  <div className="flex flex-col gap-3">
                    <button
                      type="button"
                      onClick={clearSelection}
                      className="-ml-2 inline-flex min-h-11 w-fit cursor-pointer items-center gap-1 rounded-md border-0 bg-transparent px-2 text-sm font-semibold text-fg-muted hover:text-fg-primary"
                    >
                      <ArrowLeft size={16} aria-hidden /> About this run
                    </button>
                    <StepDetail run={run} step={selected} projectId={projectId} onSelect={select} />
                  </div>
                ) : (
                  about
                )}
              </aside>
            ) : (
              <Panel className="p-4" label="About this run">
                {about}
              </Panel>
            )}
          </div>
        )}
      </div>
    </Page>
  );
}
