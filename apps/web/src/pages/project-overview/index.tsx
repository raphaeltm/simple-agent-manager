/**
 * Project Overview (Inbox slice F1, idea 01M7G03ZCQ6TM6CMEYDRKQ8ST9, section 4.2): what is
 * running, what the accounts have left, which automations are broken, what happened recently,
 * and a task box that starts work without leaving the page.
 *
 * It is the project's landing page (inbox slice F2): `/projects/:id` redirects here, and chat is
 * one tap away (the Chat nav item on desktop, the Chat control in the phone app bar).
 *
 * Layout (`OverviewLayout`): one DOM tree that CSS arranges, so crossing the phone/desktop
 * breakpoint never remounts the task box or a section (`apps/web/.claude/rules/48`, rule 5).
 * - Phone: one scrolling column in `PHONE_ORDER`, the task box pinned under it.
 * - Desktop: a wide `main` column (the brief slot, then Needs you) with the task box pinned under
 *   it, and a `rail` (Running now, This week, Budgets, Automations, Recently).
 */
import { MessageSquare } from 'lucide-react';
import { type ReactNode, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router';

import { useAppShell } from '../../components/AppShell';
import { useProfileUsages } from '../../components/project-chat/profile-picker';
import { useIsMobile } from '../../hooks/useIsMobile';
import { useNewChatComposer } from '../project-chat/useNewChatComposer';
import { useProjectContext } from '../ProjectContext';
import { AutomationsSection } from './AutomationsSection';
import { BudgetsSection } from './BudgetsSection';
import { NeedsYouSection, useNeedsYou } from './NeedsYouSection';
import { OverviewTaskBox } from './OverviewTaskBox';
import { RecentlySection, RunningNowSection } from './sections';
import { ThisWeekSection } from './ThisWeekSection';
import { useProjectOverview } from './useProjectOverview';

/**
 * Phone order of the sections, as Tailwind `order-*` classes (desktop ignores them). The Insights
 * build's This week pane sits directly under Running now.
 */
const PHONE_ORDER = {
  needsYou: 'order-1 md:order-none',
  running: 'order-2 md:order-none',
  thisWeek: 'order-3 md:order-none',
  budgets: 'order-4 md:order-none',
  automations: 'order-5 md:order-none',
  recently: 'order-6 md:order-none',
} as const;

/**
 * Chat, one tap from the landing page: on a phone it takes the app bar's primary slot (the
 * project chat puts its own chat-list toggle there). Desktop has the Chat nav item.
 */
function usePhoneChatControl(projectId: string) {
  const isMobile = useIsMobile();
  const navigate = useNavigate();
  const { setScreenAction } = useAppShell();
  const action = useMemo(
    () =>
      isMobile
        ? {
            label: 'Chat',
            icon: <MessageSquare size={20} strokeWidth={1.75} />,
            onClick: () => navigate(`/projects/${projectId}/chat`),
          }
        : null,
    [isMobile, navigate, projectId]
  );
  useEffect(() => {
    setScreenAction(action);
    return () => setScreenAction(null);
  }, [action, setScreenAction]);
}

const GUTTER = 'gap-[var(--sam-space-gutter)]';

/*
 * Nothing between a pane and the void may clip, or the pane's shadow is cut off at that box's
 * edge (rule 80). The page has to scroll, so each scroller's box reaches out to whatever is next
 * to it (the screen edge, the app bar or nav, the task box, the other column) and pads back the
 * same distance: the panes stay where they were, their shadows fall inside the scroller, and a
 * pane scrolled out of view passes under its neighbour instead of being cut in mid-air.
 * `--sam-shell-frame` and `--sam-shell-gap` come from `AppShell`.
 */
const PHONE_SCROLL_BLEED =
  '-mx-[var(--sam-shell-frame)] px-[var(--sam-shell-frame)] -mt-[var(--sam-shell-gap)] pt-[var(--sam-shell-gap)] -mb-[var(--sam-space-gutter)] pb-[var(--sam-space-gutter)]';
const DESKTOP_MAIN_BLEED =
  'md:-mt-[var(--sam-shell-frame)] md:pt-[var(--sam-shell-frame)] md:-ml-[var(--sam-shell-gap)] md:pl-[var(--sam-shell-gap)] md:-mr-[var(--sam-space-gutter)] md:pr-[var(--sam-space-gutter)] md:-mb-[var(--sam-space-gutter)] md:pb-[var(--sam-space-gutter)]';
const DESKTOP_RAIL_BLEED =
  'md:-mt-[var(--sam-shell-frame)] md:pt-[var(--sam-shell-frame)] md:-mr-[var(--sam-shell-frame)] md:pr-[var(--sam-shell-frame)] md:-mb-[var(--sam-shell-frame)] md:pb-[var(--sam-shell-frame)] md:-ml-[var(--sam-space-gutter)] md:pl-[var(--sam-space-gutter)]';

/**
 * Phone: the scroller is a flex column and both column wrappers are `display: contents`, so
 * every section is a flex item ordered by `PHONE_ORDER`. Desktop: the scroller is `contents`,
 * so the two columns become grid items of the root and each scrolls on its own. Every scroller
 * bleeds into its surroundings (`PHONE_SCROLL_BLEED` and the desktop pair) so it never clips a
 * pane's shadow; the task box stacks above the scroller that reaches its top edge.
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
        className={`relative flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto ${GUTTER} ${PHONE_SCROLL_BLEED} md:contents`}
        data-testid="overview-scroll"
      >
        <div
          className={`contents md:relative md:col-start-1 md:row-start-1 md:flex md:min-h-0 md:min-w-0 md:flex-col md:overflow-y-auto ${GUTTER} ${DESKTOP_MAIN_BLEED}`}
          data-testid="overview-main"
        >
          {main}
        </div>
        <div
          className={`contents md:relative md:col-start-2 md:row-span-2 md:row-start-1 md:flex md:min-h-0 md:min-w-0 md:flex-col md:overflow-y-auto ${GUTTER} ${DESKTOP_RAIL_BLEED}`}
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
  const needsYou = useNeedsYou(projectId);
  usePhoneChatControl(projectId);
  const composer = useNewChatComposer();
  // The same usage the task box's ring shows; Budgets reads it rather than fetching again.
  const profileUsages = useProfileUsages(composer.agentProfiles, projectId, true);
  const unavailable = new Set(overview.data?.unavailable ?? []);
  const loading = overview.isPending;

  return (
    <OverviewLayout
      main={
        <>
          {/* BRIEF SLOT (inbox slice I, spec 4.3): the generated brief renders here, above Needs
              you. Nothing renders here until then: no placeholder. */}
          <NeedsYouSection
            projectId={projectId}
            needsYou={needsYou}
            className={PHONE_ORDER.needsYou}
          />
        </>
      }
      rail={
        <>
          <RunningNowSection
            projectId={projectId}
            items={overview.running.items}
            total={overview.running.total}
            waitingOnViewerTotal={overview.running.waitingOnViewerTotal}
            pausedSessionIds={needsYou.pausedSessionIds}
            loading={loading}
            unavailable={overview.isError || unavailable.has('running')}
            className={PHONE_ORDER.running}
          />
          {/* Insights slice F: the week's flow, linking into Insights. Under Running now. */}
          <ThisWeekSection projectId={projectId} className={PHONE_ORDER.thisWeek} />
          <BudgetsSection
            projectId={projectId}
            profiles={composer.agentProfiles}
            usages={profileUsages}
            className={PHONE_ORDER.budgets}
          />
          <AutomationsSection projectId={projectId} className={PHONE_ORDER.automations} />
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
