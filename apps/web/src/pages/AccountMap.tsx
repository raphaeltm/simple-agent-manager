import {
  buttonClassName,
  Pane,
  SearchField,
  SegmentedControl,
  Spinner,
} from '@simple-agent-manager/ui';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useCallback, useMemo, useState } from 'react';

import {
  buildConnectionsModel,
  chainOf,
  type ConnectionsModel,
  type MapFilter,
  selectConnectionsView,
} from '../components/account-map/connections-model';
import { ConnectionsColumns } from '../components/account-map/ConnectionsColumns';
import { ConnectionsList } from '../components/account-map/ConnectionsList';
import { ConnectionsPathBar } from '../components/account-map/ConnectionsPath';
import { useIsMobile } from '../hooks/useIsMobile';
import { useMediaQuery } from '../hooks/useMediaQuery';
import { useQueryScope } from '../hooks/useQueryScope';
import type { AccountMapResponse } from '../lib/api';
import { accountMapQueryOptions } from '../lib/query-options';

/** What the server left out, in one sentence, so a partial map never passes for a full one. */
function truncationNotice(data: AccountMapResponse): string {
  const { truncation, ideaScan } = data;
  const omitted = [
    truncation.projects && 'projects',
    truncation.nodes && 'machines',
    truncation.workspaces && 'workspaces',
    truncation.sessions && 'chats',
    truncation.tasks && 'tasks',
  ].filter(Boolean);
  const parts = [
    truncation.incomplete && 'Some map data could not be loaded. Refresh to try again.',
    truncation.linkProjects &&
      (ideaScan?.projectLimit
        ? `Ideas checked in the ${ideaScan.projectLimit} most recent projects.`
        : 'Ideas checked in recent projects only.'),
    truncation.ideas &&
      (ideaScan?.candidateLimit
        ? `Only the ${ideaScan.candidateLimit} newest ideas were checked for chat links.`
        : 'Only recent ideas were checked for chat links.'),
    omitted.length > 0 && `Some ${omitted.join(', ')} were omitted.`,
    truncation.links && 'Some idea-to-chat links may be omitted.',
  ].filter(Boolean);
  return parts.length > 0 ? `${parts.join(' ')} Open a project or idea for its full history.` : '';
}

/** Below this width the three columns and their lines do not fit, so work is listed by project. */
const COLUMNS_QUERY = '(min-width: 1024px)';

function filterCounts(model: ConnectionsModel) {
  let attention = 0;
  let live = 0;
  for (const w of model.work) {
    if (w.state === 'needs-you' || w.state === 'failed') attention += 1;
    if (w.state === 'needs-you' || w.state === 'working') live += 1;
  }
  return { all: model.work.length, attention, live };
}

export function AccountMap() {
  const isMobile = useIsMobile();
  const columns = useMediaQuery(COLUMNS_QUERY) && !isMobile;
  const queryScope = useQueryScope();
  const [showFinished, setShowFinished] = useState(false);
  const [filter, setFilter] = useState<MapFilter>('all');
  const [search, setSearch] = useState('');
  const [showQuiet, setShowQuiet] = useState(false);
  // `undefined` until the user picks something: until then the first chat waiting on them is picked.
  const [picked, setPicked] = useState<string | null | undefined>(undefined);

  const query = useQuery({
    ...accountMapQueryOptions(queryScope, !showFinished),
    enabled: Boolean(queryScope),
    // Keep the current map on screen while "Show finished" loads the larger one.
    placeholderData: keepPreviousData,
  });

  const model = useMemo(
    () => (query.data ? buildConnectionsModel(query.data) : null),
    [query.data]
  );
  const view = useMemo(
    () => (model ? selectConnectionsView(model, filter, search) : null),
    [model, filter, search]
  );

  const visibleIds = useMemo(() => {
    if (!view) return new Set<string>();
    return new Set([
      ...view.projects.map((p) => p.id),
      ...(showQuiet ? view.quietProjects.map((p) => p.id) : []),
      ...view.work.map((w) => w.id),
      ...view.machines.map((m) => m.id),
    ]);
  }, [view, showQuiet]);
  const wanted =
    picked === undefined ? (view?.work.find((w) => w.state === 'needs-you')?.id ?? null) : picked;
  const selectedId = wanted && visibleIds.has(wanted) ? wanted : null;
  const chain = useMemo(
    () => (model ? chainOf(model, selectedId) : new Set<string>()),
    [model, selectedId]
  );
  const select = useCallback((id: string) => setPicked((cur) => (cur === id ? null : id)), []);

  if (query.isLoading || (!query.data && !query.isError)) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner size="lg" />
      </div>
    );
  }

  if (!query.data || !model || !view) {
    const reason = query.error instanceof Error ? query.error.message : 'Failed to load the map';
    return (
      <div
        role="alert"
        className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center"
      >
        <p className="m-0 text-[15px] text-fg-primary">{reason}</p>
        <button
          type="button"
          onClick={() => void query.refetch()}
          className={buttonClassName({ variant: 'accent', size: 'sm' })}
        >
          Retry
        </button>
      </div>
    );
  }

  const counts = filterCounts(model);
  const notice = truncationNotice(query.data);
  const empty = model.work.length === 0 && model.machines.length === 0;

  const header = (
    <Pane variant="slab" as="header" className="flex shrink-0 flex-col gap-3 px-4 py-3.5 sm:px-5">
      <div>
        <h1 className="m-0 text-[22px] font-bold text-fg-primary sm:text-[24px]">
          How it all connects
        </h1>
        <p className="m-0 mt-1 text-[13.5px] text-fg-muted">
          Each chat, the project it belongs to, and the machine it runs on.
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <SegmentedControl<MapFilter>
          label="Show"
          value={filter}
          onChange={setFilter}
          className={isMobile ? 'w-full' : 'w-[340px]'}
          options={[
            {
              value: 'all',
              // "Everything" does not fit beside the other two options on a 375px phone.
              label: isMobile ? 'All' : 'Everything',
              count: counts.all,
              ariaLabel: `Everything, ${counts.all}`,
            },
            {
              value: 'attention',
              label: 'Needs you',
              count: counts.attention,
              ariaLabel: `Needs you, ${counts.attention}`,
            },
            { value: 'live', label: 'Live', count: counts.live, ariaLabel: `Live, ${counts.live}` },
          ]}
        />
        <SearchField
          value={search}
          onValueChange={setSearch}
          label="Search the map"
          placeholder="Search chats, projects, machines"
          className="min-w-0 flex-1 basis-[220px]"
        />
        <button
          type="button"
          aria-pressed={showFinished}
          onClick={() => setShowFinished((v) => !v)}
          className={buttonClassName({ variant: 'raised', size: 'sm' })}
        >
          {showFinished ? 'Hide finished' : 'Show finished'}
        </button>
        {query.isFetching && <Spinner size="sm" />}
      </div>
      {columns && !empty && (
        <div className="flex min-h-[46px] items-center border-0 border-t border-solid border-[var(--sam-hairline)] pt-3">
          <ConnectionsPathBar model={model} selectedId={selectedId} />
        </div>
      )}
    </Pane>
  );

  const body = empty ? (
    <div className="flex flex-col items-center gap-2 px-6 py-12 text-center">
      <p className="m-0 text-[15px] font-semibold text-fg-primary">Nothing to connect yet</p>
      <p className="m-0 max-w-[360px] text-[13px] text-fg-muted">
        {showFinished
          ? 'Start a chat in a project and it shows up here, linked to the machine it runs on.'
          : 'Nothing is running right now. Start a chat, or show finished work.'}
      </p>
    </div>
  ) : !columns ? (
    <ConnectionsList
      model={model}
      view={view}
      selectedId={selectedId}
      onSelect={select}
      showQuiet={showQuiet}
      onToggleQuiet={() => setShowQuiet((v) => !v)}
    />
  ) : (
    <ConnectionsColumns
      model={model}
      view={view}
      chain={chain}
      selectedId={selectedId}
      onSelect={select}
      showQuiet={showQuiet}
      onToggleQuiet={() => setShowQuiet((v) => !v)}
    />
  );

  const noticeLine = notice && (
    <p role="status" className="m-0 px-1 text-[12px] text-fg-muted">
      {notice}
    </p>
  );

  if (isMobile) {
    return (
      <div
        data-testid="account-map-root"
        className="flex w-full min-w-0 flex-col gap-2.5 p-2.5 pb-8"
      >
        {header}
        {noticeLine}
        {body}
      </div>
    );
  }

  return (
    <div data-testid="account-map-root" className="flex h-full w-full min-w-0 flex-col gap-3 p-4">
      {header}
      {noticeLine}
      <div className="relative min-h-0 flex-1 overflow-y-auto">{body}</div>
    </div>
  );
}
