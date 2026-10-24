/**
 * Ideas: what needs you comes first.
 *
 * The order is the whole point. Problems and decisions are at the top with their fix as a
 * button, then what is in progress, then what has not started. Ideas that are finished and
 * ideas an automation filed fold away at the bottom, where they can be opened but cannot
 * crowd out the ones a person cares about.
 *
 * Nothing here is set by hand: every row's state comes from the chats and pull requests
 * linked to that idea, so it stays true without anyone updating it.
 */
import type { IdeaListItem } from '@simple-agent-manager/shared';
import { Button, Spinner } from '@simple-agent-manager/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, Lightbulb, Plus, Search } from 'lucide-react';
import { type ReactNode, useCallback, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';

import { useIsMobile } from '../../hooks/useIsMobile';
import { useQueryScope } from '../../hooks/useQueryScope';
import { useToast } from '../../hooks/useToast';
import { keepProjectIdeaOpen, setProjectIdeaStatus } from '../../lib/api';
import { ideaQueryKeys, ideasListQueryOptions } from '../../lib/query-options';
import { LoadError, Page, PageHeader } from '../automation/page';
import { Disclosure, Panel, SectionTitle } from '../automation/ui';
import { useProjectContext } from '../ProjectContext';
import { NewIdeaDialog } from './NewIdeaDialog';
import {
  AgentFiledIcon,
  type IdeaActionHandlers,
  IdeaAttentionCard,
  ideaPath,
  IdeaRow,
  IdeaStateIcon,
} from './parts';
import { groupIdeas, IDEA_NEEDS_YOU_VISIBLE, ideaAttention, ideaMatchesSearch } from './view-model';

function Rows({
  title,
  hint,
  items,
  projectId,
  leading,
}: {
  title: string;
  hint?: string;
  items: IdeaListItem[];
  projectId: string;
  leading?: (item: IdeaListItem) => ReactNode;
}) {
  if (items.length === 0) return null;
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <SectionTitle title={title} count={items.length} hint={hint} />
      <Panel className="overflow-hidden" label={title}>
        {items.map((item) => (
          <IdeaRow key={item.ideaId} item={item} projectId={projectId} leading={leading?.(item)} />
        ))}
      </Panel>
    </div>
  );
}

function NeedsYou({
  items,
  projectId,
  handlers,
}: {
  items: IdeaListItem[];
  projectId: string;
  handlers: IdeaActionHandlers;
}) {
  const [expanded, setExpanded] = useState(false);
  const cards = useMemo(
    () =>
      items
        .map((item) => ({ item, attention: ideaAttention(item) }))
        .filter(
          (
            entry
          ): entry is {
            item: IdeaListItem;
            attention: NonNullable<ReturnType<typeof ideaAttention>>;
          } => entry.attention !== null
        ),
    [items]
  );
  if (cards.length === 0) return null;
  const visible = expanded ? cards : cards.slice(0, IDEA_NEEDS_YOU_VISIBLE);
  const hidden = cards.length - visible.length;
  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid="ideas-needs-you">
      <SectionTitle title="Needs you" count={cards.length} />
      {visible.map(({ item, attention }) => (
        <IdeaAttentionCard
          key={item.ideaId}
          item={item}
          attention={attention}
          projectId={projectId}
          handlers={handlers}
        />
      ))}
      {hidden > 0 && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="flex min-h-11 w-full cursor-pointer items-center justify-center gap-1 rounded-xl border border-dashed border-border-default bg-transparent text-sm font-semibold text-accent hover:bg-surface-hover"
        >
          {hidden} more need you
          <ChevronDown size={16} aria-hidden />
        </button>
      )}
    </div>
  );
}

/** "Ideas move on their own" — the side column's explanation of where states come from. */
function HowIdeasMove() {
  const steps: Array<[Parameters<typeof IdeaStateIcon>[0]['state'], string]> = [
    ['not-started', 'Not started until someone starts work'],
    ['working', 'In progress while a chat works on it'],
    ['review', 'In review when a pull request is open'],
    ['merged', 'Merged: you decide if it’s done'],
  ];
  return (
    <Panel label="How ideas move" className="flex min-w-0 flex-col gap-3 p-4">
      <p className="m-0 text-[15px] font-semibold text-fg-primary">Ideas move on their own</p>
      <ul className="m-0 flex list-none flex-col gap-2.5 p-0">
        {steps.map(([state, text]) => (
          <li key={state} className="flex items-center gap-3 text-[13px] text-fg-muted">
            <IdeaStateIcon state={state} size="sm" />
            <span className="min-w-0 break-words">{text}</span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

function EmptyIdeas({ onNew }: { onNew: () => void }) {
  return (
    <Panel
      label="No ideas yet"
      className="flex min-w-0 flex-col items-center gap-4 px-6 py-10 text-center"
    >
      <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-accent-tint text-accent">
        <Lightbulb size={26} aria-hidden />
      </span>
      <div className="flex max-w-md flex-col gap-2">
        <h2 className="m-0 text-[19px] font-semibold text-fg-primary">No ideas yet</h2>
        <p className="m-0 text-[15px] text-fg-muted">
          Ideas hold what you want done until you start work on it. Agents add them from chats, and
          you can add one any time.
        </p>
      </div>
      <Button onClick={onNew}>
        <Plus size={18} aria-hidden /> File your first idea
      </Button>
    </Panel>
  );
}

export function IdeasListPage() {
  const { projectId } = useProjectContext();
  const isMobile = useIsMobile();
  const queryScope = useQueryScope();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const [search, setSearch] = useState('');
  const [newIdeaOpen, setNewIdeaOpen] = useState(false);

  const ideasQuery = useQuery({
    ...ideasListQueryOptions(queryScope, projectId),
    enabled: Boolean(projectId && queryScope),
  });

  const refreshIdeas = useCallback(() => {
    // Invalidate rather than reload: the list stays on screen and refreshes under it.
    void queryClient.invalidateQueries({ queryKey: ideaQueryKeys.all(queryScope) });
  }, [queryClient, queryScope]);

  const markDone = useMutation({
    mutationFn: (ideaId: string) => setProjectIdeaStatus(projectId, ideaId, 'completed'),
    onSuccess: () => {
      toast.success('Marked done');
      refreshIdeas();
    },
    onError: (error: unknown) => {
      toast.error(error instanceof Error ? error.message : 'Could not mark it done');
    },
  });

  const park = useMutation({
    mutationFn: (ideaId: string) => setProjectIdeaStatus(projectId, ideaId, 'cancelled'),
    onSuccess: () => {
      toast.success('Parked');
      refreshIdeas();
    },
    onError: (error: unknown) => {
      toast.error(error instanceof Error ? error.message : 'Could not park it');
    },
  });

  const reopen = useMutation({
    mutationFn: (ideaId: string) => setProjectIdeaStatus(projectId, ideaId, 'draft'),
    onSuccess: () => {
      toast.success('Reopened');
      refreshIdeas();
    },
    onError: (error: unknown) => {
      toast.error(error instanceof Error ? error.message : 'Could not reopen it');
    },
  });

  const keepOpen = useMutation({
    mutationFn: (ideaId: string) => keepProjectIdeaOpen(projectId, ideaId),
    onSuccess: () => {
      toast.success('Kept open');
      refreshIdeas();
    },
    onError: (error: unknown) => {
      toast.error(error instanceof Error ? error.message : 'Could not keep it open');
    },
  });

  const handlers: IdeaActionHandlers = useMemo(
    () => ({
      onMarkDone: (ideaId: string) => markDone.mutate(ideaId),
      onPark: (ideaId: string) => park.mutate(ideaId),
      onReopen: (ideaId: string) => reopen.mutate(ideaId),
      // "Keep open" leaves the idea exactly where it is; what it records is that a person
      // answered the merged question, so the card does not come back tomorrow.
      onKeepOpen: (ideaId: string) => keepOpen.mutate(ideaId),
      pending: markDone.isPending || park.isPending || reopen.isPending || keepOpen.isPending,
    }),
    [markDone, park, reopen, keepOpen]
  );

  const handleNewIdea = useCallback(() => setNewIdeaOpen(true), []);
  const handleIdeaCreated = useCallback(
    (ideaId: string) => {
      refreshIdeas();
      navigate(ideaPath(projectId, ideaId));
    },
    [navigate, projectId, refreshIdeas]
  );

  const items = useMemo(() => ideasQuery.data?.items ?? [], [ideasQuery.data]);
  const filtered = useMemo(
    () => items.filter((item) => ideaMatchesSearch(item, search)),
    [items, search]
  );
  const groups = useMemo(() => groupIdeas(filtered), [filtered]);
  const totals = ideasQuery.data?.totals;

  // Stale-while-revalidate: the spinner gates only the very first read, so a background
  // refresh never unmounts the list under someone's thumb (rule 48).
  if (ideasQuery.data === undefined) {
    if (ideasQuery.error) {
      return (
        <Page wide>
          <PageHeader title="Ideas" subtitle="Things you want done." />
          <LoadError
            what="your ideas"
            error={ideasQuery.error}
            onRetry={() => void ideasQuery.refetch()}
          />
        </Page>
      );
    }
    return (
      <div className="flex items-center justify-center py-12" role="status">
        <Spinner size="lg" />
        <span className="sr-only">Loading ideas</span>
      </div>
    );
  }

  const header = (
    <>
      <PageHeader
        title="Ideas"
        subtitle="Things you want done. Start work on one when it’s ready."
        action={
          <Button onClick={handleNewIdea} className="shrink-0">
            <Plus size={18} aria-hidden />
            {isMobile ? 'New' : 'New idea'}
          </Button>
        }
      />
      {items.length > 0 && (
        <label className="relative block min-w-0">
          <span className="sr-only">Search ideas</span>
          <Search
            size={16}
            aria-hidden
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-fg-muted"
          />
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search ideas"
            className="min-h-11 w-full rounded-lg border border-[var(--sam-form-border)] bg-inset py-2 pl-9 pr-3 text-sm text-fg-primary placeholder:text-fg-muted focus:border-accent focus:outline-none"
          />
        </label>
      )}
    </>
  );

  const newIdeaDialog = (
    <NewIdeaDialog
      projectId={projectId}
      open={newIdeaOpen}
      onClose={() => setNewIdeaOpen(false)}
      onCreated={handleIdeaCreated}
    />
  );

  if (items.length === 0) {
    return (
      <Page wide>
        {header}
        <EmptyIdeas onNew={handleNewIdea} />
        {newIdeaDialog}
      </Page>
    );
  }

  const main = (
    <>
      <NeedsYou items={groups.needsYou} projectId={projectId} handlers={handlers} />
      <Rows title="In progress" items={groups.inProgress} projectId={projectId} />
      <Rows
        title="Not started"
        hint="Newest first"
        items={groups.notStarted}
        projectId={projectId}
      />
      {filtered.length === 0 && (
        <Panel className="px-4 py-8 text-center" label="No matches">
          <p className="m-0 text-sm text-fg-muted">No ideas match “{search}”.</p>
        </Panel>
      )}
    </>
  );

  const done = (
    <Rows
      title="Done recently"
      hint={
        totals && totals.done > groups.doneRecently.length ? `${totals.done} in total` : undefined
      }
      items={groups.doneRecently}
      projectId={projectId}
    />
  );

  const filedByAgents =
    groups.filedByAgents.length > 0 ? (
      <Disclosure
        title={`Filed by agents · ${groups.filedByAgents.length}`}
        hint="Errors and findings agents noticed"
        testId="ideas-filed-by-agents"
      >
        <Panel className="overflow-hidden" label="Filed by agents">
          {groups.filedByAgents.map((item) => (
            <IdeaRow
              key={item.ideaId}
              item={item}
              projectId={projectId}
              leading={<AgentFiledIcon />}
            />
          ))}
        </Panel>
      </Disclosure>
    ) : null;

  return (
    <Page wide>
      {header}
      {isMobile ? (
        <>
          {main}
          {groups.doneRecently.length > 0 && (
            <Disclosure
              title={`Done recently · ${groups.doneRecently.length}`}
              hint="Finished and parked"
              testId="ideas-done-recently"
            >
              <Panel className="overflow-hidden" label="Done recently">
                {groups.doneRecently.map((item) => (
                  <IdeaRow key={item.ideaId} item={item} projectId={projectId} />
                ))}
              </Panel>
            </Disclosure>
          )}
          {filedByAgents}
        </>
      ) : (
        <div className="grid min-w-0 grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,1fr)_340px] lg:gap-8">
          <div className="flex min-w-0 flex-col gap-6">{main}</div>
          <div className="flex min-w-0 flex-col gap-6">
            <HowIdeasMove />
            {done}
            {filedByAgents}
          </div>
        </div>
      )}
      {ideasQuery.data.truncated && (
        <p className="m-0 text-[13px] text-fg-muted">
          Showing the most recent ideas. {totals?.open ?? 0} are open in total.
        </p>
      )}
      {newIdeaDialog}
    </Page>
  );
}
