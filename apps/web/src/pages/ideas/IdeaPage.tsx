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
  ideaUpdatesQueryOptions,
} from '../../lib/query-options';
import { LoadError, Page, PageHeader } from '../automation/page';
import { useProjectContext } from '../ProjectContext';
import { EditIdeaDialog } from './EditIdeaDialog';
import { IdeaUpdates, IdeaWork } from './idea-activity';
import { IdeaPlan, IdeaRelated, IdeaStatusCard } from './idea-sections';
import type { IdeaActionHandlers } from './parts';

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
  const updatesQuery = useQuery({
    ...ideaUpdatesQueryOptions(queryScope, projectId, ideaId),
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
      void queryClient.invalidateQueries({
        queryKey: ideaQueryKeys.updates(queryScope, projectId, ideaId),
      });
    },
    onError: (error: unknown) =>
      toast.error(error instanceof Error ? error.message : 'Could not post the update'),
  });

  const handlers: IdeaActionHandlers = useMemo(
    () => ({
      onMarkDone: () => markDone.mutate(),
      onPark: () => park.mutate(),
      onReopen: () => reopen.mutate(),
      onKeepOpen: () => keepOpen.mutate(),
      pending: markDone.isPending || park.isPending || reopen.isPending || keepOpen.isPending,
    }),
    [markDone, park, reopen, keepOpen]
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
      updates={updatesQuery.data?.updates}
      projectId={projectId}
      onPost={(body) => postUpdate.mutate(body)}
      posting={postUpdate.isPending}
      error={updatesQuery.data === undefined ? updatesQuery.error : null}
      onRetry={() => void updatesQuery.refetch()}
      canWrite
    />
  );
  const related = <IdeaRelated links={linksQuery.data} projectId={projectId} />;

  const dialog = (
    <EditIdeaDialog
      projectId={projectId}
      idea={idea}
      open={editing}
      onClose={() => setEditing(false)}
      onSaved={refresh}
    />
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
        {dialog}
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
      {dialog}
    </Page>
  );
}
