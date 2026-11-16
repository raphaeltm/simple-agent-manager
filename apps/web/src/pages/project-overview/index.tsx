/**
 * Project Overview (Inbox slice F1, idea 01M7G03ZCQ6TM6CMEYDRKQ8ST9, section 4.2): what is
 * running, what the accounts have left, which automations are broken, what happened recently,
 * and a task box that starts work without leaving the page.
 *
 * Layout (`OverviewLayout`): one DOM tree that CSS arranges, so crossing the phone/desktop
 * breakpoint never remounts the task box or a section (`apps/web/.claude/rules/48`, rule 5).
 * - Phone: one scrolling column in `PHONE_ORDER`, the task box pinned under it.
 * - Desktop: a wide `main` column with the task box pinned under it, and a `rail`.
 *
 * Later slices: F2 adds the brief and Needs you. They go at the top of `main`, Running now and
 * Recently move to the `rail`, and `PHONE_ORDER` puts Needs you first. Each is a slot
 * assignment below; no section needs to change.
 */
import type { ReactNode } from 'react';

import { useProfileUsages } from '../../components/project-chat/profile-picker';
import { useNewChatComposer } from '../project-chat/useNewChatComposer';
import { useProjectContext } from '../ProjectContext';
import { AutomationsSection } from './AutomationsSection';
import { BudgetsSection } from './BudgetsSection';
import { OverviewTaskBox } from './OverviewTaskBox';
import { RecentlySection, RunningNowSection } from './sections';
import { ThisWeekSection } from './ThisWeekSection';
import { useProjectOverview } from './useProjectOverview';

/** Phone order of the sections, as Tailwind `order-*` classes (desktop ignores them). */
const PHONE_ORDER = {
  running: 'order-1 md:order-none',
  thisWeek: 'order-2 md:order-none',
  budgets: 'order-3 md:order-none',
  automations: 'order-4 md:order-none',
  recently: 'order-5 md:order-none',
} as const;

const GUTTER = 'gap-[var(--sam-space-gutter)]';

/**
 * Phone: the scroller is a flex column and both column wrappers are `display: contents`, so
 * every section is a flex item ordered by `PHONE_ORDER`. Desktop: the scroller is `contents`,
 * so the two columns become grid items of the root and each scrolls on its own.
 */
export function OverviewLayout({
  main,
  rail,
  taskBox,
}: {
  main: ReactNode;
  rail: ReactNode;
  taskBox: ReactNode;
}) {
  return (
    <div
      className={`flex min-h-0 min-w-0 flex-1 flex-col ${GUTTER} md:grid md:grid-cols-[minmax(0,1fr)_minmax(300px,380px)] md:grid-rows-[minmax(0,1fr)_auto]`}
      data-testid="project-overview"
    >
      <div
        className={`relative flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto ${GUTTER} md:contents`}
        data-testid="overview-scroll"
      >
        <div
          className={`contents md:relative md:col-start-1 md:row-start-1 md:flex md:min-h-0 md:min-w-0 md:flex-col md:overflow-y-auto ${GUTTER}`}
          data-testid="overview-main"
        >
          {main}
        </div>
        <div
          className={`contents md:relative md:col-start-2 md:row-span-2 md:row-start-1 md:flex md:min-h-0 md:min-w-0 md:flex-col md:overflow-y-auto ${GUTTER}`}
          data-testid="overview-rail"
        >
          {rail}
        </div>
      </div>
      <div className="relative z-20 shrink-0 md:col-start-1 md:row-start-2">{taskBox}</div>
    </div>
  );
}

export function ProjectOverview() {
  const { projectId } = useProjectContext();
  const overview = useProjectOverview(projectId);
  const composer = useNewChatComposer();
  // The same usage the task box's ring shows; Budgets reads it rather than fetching again.
  const profileUsages = useProfileUsages(composer.agentProfiles, projectId, true);
  const unavailable = new Set(overview.data?.unavailable ?? []);
  const loading = overview.isPending;

  return (
    <OverviewLayout
      main={
        <>
          <RunningNowSection
            projectId={projectId}
            items={overview.running.items}
            total={overview.running.total}
            waitingOnViewerTotal={overview.running.waitingOnViewerTotal}
            loading={loading}
            unavailable={overview.isError || unavailable.has('running')}
            className={PHONE_ORDER.running}
          />
          <RecentlySection
            projectId={projectId}
            ideas={overview.data?.recent.ideas ?? []}
            pullRequests={overview.data?.recent.mergedPullRequests ?? []}
            loading={loading}
            ideasUnavailable={overview.isError || unavailable.has('ideas')}
            pullRequestsUnavailable={overview.isError || unavailable.has('pullRequests')}
            className={PHONE_ORDER.recently}
          />
        </>
      }
      rail={
        <>
          {/* Insights slice F: the week's flow, linking into Insights. Top of the rail. */}
          <ThisWeekSection projectId={projectId} className={PHONE_ORDER.thisWeek} />
          <BudgetsSection
            projectId={projectId}
            profiles={composer.agentProfiles}
            usages={profileUsages}
            className={PHONE_ORDER.budgets}
          />
          <AutomationsSection projectId={projectId} className={PHONE_ORDER.automations} />
        </>
      }
      taskBox={
        <OverviewTaskBox
          composer={composer}
          profileUsages={profileUsages}
          onStarted={overview.addPendingStart}
        />
      }
    />
  );
}
