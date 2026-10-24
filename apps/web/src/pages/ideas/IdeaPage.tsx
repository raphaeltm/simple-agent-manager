/**
 * One idea: where it stands, the current plan, the work, the updates and what is related.
 *
 * The old page was the idea's text plus a conversations drawer, and the text was where agents
 * appended everything they learned until it contradicted itself. Here the text is the plan and
 * nothing else; the history lives in Updates, the chats and pull requests live in Work, and
 * the status comes from them rather than from a label anyone typed.
 *
 * On a phone it is one column in that order. On a laptop the plan and its updates stay on the
 * left and the status, work and related move to the right — the same order, more room.
 */
import { Spinner } from '@simple-agent-manager/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo, useState } from 'react';
import { useParams } from 'react-router';

import { useIsMobile } from '../../hooks/useIsMobile';
import { useQueryScope } from '../../hooks/useQueryScope';
import { useToast } from '../../hooks/useToast';
import { keepProjectIdeaOpen, postIdeaUpdate, setProjectIdeaStatus } from '../../lib/api';
import {
  ideaDetailQueryOptions,
  ideaLinksQueryOptions,
  ideaQueryKeys,
} from '../../lib/query-options';
import { LoadError, Page, PageHeader } from '../automation/page';
import { useProjectContext } from '../ProjectContext';
import { EditIdeaDialog } from './EditIdeaDialog';
import { IdeaUpdates, IdeaWork } from './idea-activity';
import { IdeaPlan, IdeaRelated, IdeaStatusCard } from './idea-sections';
import { ideaTimeline } from './idea-timeline';
import type { IdeaActionHandlers } from './parts';
import { useStartWorkLauncher } from './useStartWorkLauncher';

export function IdeaPage() {
  const { projectId } = useProjectContext();
  const { taskId: ideaId = '' } = useParams<{ taskId: string }>();
  const isMobile = useIsMobile();
  const queryScope = useQueryScope();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [editing, setEditing] = useState(false);

  const enabled = Boolean(projectId && ideaId && queryScope);
  const ideaQuery = useQuery({
    ...ideaDetailQueryOptions(queryScope, projectId, ideaId),
    enabled,
  });
  const linksQuery = useQuery({
    ...ideaLinksQueryOptions(queryScope, projectId, ideaId),
    enabled,
  });

  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ideaQueryKeys.all(queryScope) });
  }, [queryClient, queryScope]);

  const markDone = useMutation({
    mutationFn: () => setProjectIdeaStatus(projectId, ideaId, 'completed'),
    onSuccess: () => {
      toast.success('Marked done');
      refresh();
    },
    onError: (error: unknown) =>
      toast.error(error instanceof Error ? error.message : 'Could not mark it done'),
  });

  const park = useMutation({
    mutationFn: () => setProjectIdeaStatus(projectId, ideaId, 'cancelled'),
    onSuccess: () => {
      toast.success('Parked');
      refresh();
    },
    onError: (error: unknown) =>
      toast.error(error instanceof Error ? error.message : 'Could not park it'),
  });

  const reopen = useMutation({
    mutationFn: () => setProjectIdeaStatus(projectId, ideaId, 'draft'),
    onSuccess: () => {
      toast.success('Reopened');
      refresh();
    },
    onError: (error: unknown) =>
      toast.error(error instanceof Error ? error.message : 'Could not reopen it'),
  });

  const keepOpen = useMutation({
    mutationFn: () => keepProjectIdeaOpen(projectId, ideaId),
    onSuccess: () => {
      toast.success('Kept open');
      refresh();
    },
    onError: (error: unknown) =>
      toast.error(error instanceof Error ? error.message : 'Could not keep it open'),
  });

  const postUpdate = useMutation({
    mutationFn: (body: string) => postIdeaUpdate(projectId, ideaId, { body }),
    onSuccess: () => {
      /*
       * Invalidate the IDEA, because that is where the timeline comes from now. This used to
       * invalidate `ideaQueryKeys.updates`, which the page no longer reads — so the note a
       * person had just written would not appear until the next poll. Exactly the shape of the
       * dead link this work exists to fix: a write path still pointing at something nothing
       * reads.
       */
      void queryClient.invalidateQueries({
        queryKey: ideaQueryKeys.detail(queryScope, projectId, ideaId),
      });
    },
    onError: (error: unknown) =>
      toast.error(error instanceof Error ? error.message : 'Could not post the update'),
  });

  // The page is scoped to one idea, so the title the sheet needs is the one already loaded.
  const titleOf = useCallback(() => ideaQuery.data?.title, [ideaQuery.data?.title]);
  const { onStartWork, startWorkSheet } = useStartWorkLauncher(titleOf);

  const handlers: IdeaActionHandlers = useMemo(
    () => ({
      onMarkDone: () => markDone.mutate(),
      onPark: () => park.mutate(),
      onReopen: () => reopen.mutate(),
      onKeepOpen: () => keepOpen.mutate(),
      onStartWork,
      pending: markDone.isPending || park.isPending || reopen.isPending || keepOpen.isPending,
    }),
    [markDone, park, reopen, keepOpen, onStartWork]
  );

  const idea = ideaQuery.data;

  // Stale-while-revalidate: only the very first read gates rendering (rule 48).
  if (idea === undefined) {
    if (ideaQuery.error) {
      return (
        <Page>
          <PageHeader title="Idea" back={{ label: 'Ideas', to: `/projects/${projectId}/ideas` }} />
          <LoadError
            what="this idea"
            error={ideaQuery.error}
            onRetry={() => void ideaQuery.refetch()}
          />
        </Page>
      );
    }
    return (
      <div className="flex items-center justify-center py-12" role="status">
        <Spinner size="lg" />
        <span className="sr-only">Loading the idea</span>
      </div>
    );
  }

  /*
   * Notes and lifecycle events in one list. Both come from `idea`, so the page makes one
   * request per tick instead of the two it used to (rule 60), and the timeline can show what
   * the work did rather than only what someone wrote about it.
   */
  const timeline = ideaTimeline(idea, idea.updates.items);
  /*
   * The count is what the TIMELINE holds, not what the notes table holds.
   *
   * `idea.updates.total` counts notes only, so it read "3" beside six visible rows once
   * lifecycle entries joined the list. Lifecycle entries are derived from the whole payload
   * rather than paged, so they are exact; the notes can be truncated, and a "+" says so
   * instead of asserting a total the slice cannot support (program decision 9).
   */
  const lifecycleCount = timeline.filter((entry) => entry.kind === 'lifecycle').length;
  const timelineTotal = `${idea.updates.total + lifecycleCount}${
    idea.updates.nextCursor ? '+' : ''
  }`;

  const header = (
    <PageHeader title={idea.title} back={{ label: 'Ideas', to: `/projects/${projectId}/ideas` }} />
  );
  const status = (
    <IdeaStatusCard idea={idea} isMobile={isMobile} projectId={projectId} handlers={handlers} />
  );
  const plan = <IdeaPlan idea={idea} onEdit={() => setEditing(true)} canEdit />;
  const work = <IdeaWork idea={idea} projectId={projectId} />;
  const updates = (
    <IdeaUpdates
      entries={timeline}
      total={timelineTotal}
      projectId={projectId}
      onPost={(body) => postUpdate.mutate(body)}
      posting={postUpdate.isPending}
      error={null}
      onRetry={() => void ideaQuery.refetch()}
      canWrite
    />
  );
  const related = <IdeaRelated links={linksQuery.data} projectId={projectId} />;

  /*
   * Both overlays in one group, rendered once per layout branch.
   *
   * The page this replaced mounted its Start work sheet separately in each branch, which is
   * one edit away from a phone-only or desktop-only Start work. Grouping them means a branch
   * cannot render the edit dialog and forget the sheet.
   */
  const overlays = (
    <>
      <EditIdeaDialog
        projectId={projectId}
        idea={idea}
        open={editing}
        onClose={() => setEditing(false)}
        onSaved={refresh}
      />
      {startWorkSheet}
    </>
  );

  if (isMobile) {
    return (
      <Page wide>
        {header}
        {status}
        {plan}
        {work}
        {updates}
        {related}
        {overlays}
      </Page>
    );
  }

  return (
    <Page wide>
      <div className="grid min-w-0 grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,1fr)_380px] lg:gap-8">
        <div className="flex min-w-0 flex-col gap-6">
          {header}
          {plan}
          {updates}
        </div>
        <div className="flex min-w-0 flex-col gap-6 lg:pt-[60px]">
          {status}
          {work}
          {related}
        </div>
      </div>
      {overlays}
    </Page>
  );
}
