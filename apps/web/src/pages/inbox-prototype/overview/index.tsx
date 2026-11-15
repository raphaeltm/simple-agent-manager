/**
 * PROTOTYPE ONLY — /prototype/project-overview (idea 01M7G03ZCQ6TM6CMEYDRKQ8ST9, section 11).
 * The page you land on when you open a project, with the refined Inbox (Direction A plus B's
 * auto-advance) one tap away. Dev-only route, mock data, no API. Remove before any merge.
 *
 * Query: ?data=normal|quiet|busy  ?variant=1|2 (phone order)  ?brief=fresh|stale|off
 *        ?screen=overview|item|inbox|all|chat  ?open=<item id>  ?filter=<filter>  ?bell=1
 *        ?failNext=1 (the next started task fails)  ?typed=1 (a long task typed)  ?sheet=1
 * Everything after the first screen is reached by clicking, as a person would.
 */
import { Pane } from '@simple-agent-manager/ui';
import { useMemo, useReducer, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';

import { useIsMobile } from '../../../hooks/useIsMobile';
import { ProjectContext } from '../../ProjectContext';
import { Filters, ItemPane, ListContent } from '../common';
import { AdvanceReceipt, ItemActions, Stepper } from '../direction-a';
import { installMockApi } from '../mock-api';
import type { InboxItem } from '../mock-data';
import {
  actionable,
  type Filter,
  findItem,
  openItems,
  queue,
  reducer,
  sceneState,
  type State,
} from '../model';
import { ChatBackdrop, Frame } from '../shell';
import { BellPopover } from './bell';
import { Brief, BriefLine, type BriefState, type BriefTarget } from './brief';
import { type StartReceipt, TaskComposer, taskTitle } from './composer';
import { PROJECT_ID, PROJECT_NAME, projectData, type ProjectState, startedChat } from './data';
import { Automations, Budgets, NeedsYou, Recently, RunningNow } from './sections';
import { BackButton, ChatAction, PhoneBar, Sidebar } from './shell';

installMockApi();

type Screen = 'overview' | 'item' | 'inbox' | 'all' | 'chat';

const LONG_TASK = `Add a "pause subscription" option to the customer portal.
Customers on Pro and Team can pause for 1–3 months instead of cancelling; Starter cannot.
While paused: no invoices, keep their data, show "Paused until <date>" on the portal and in the admin list.
Stripe: use pause_collection with behavior=void, not a coupon. Write the migration, the portal UI, the webhook handling for resumes, and tests. Open a PR, don't merge.`;

const PROJECT_CONTEXT = { projectId: PROJECT_ID, project: null, reload: async () => {} };

function failedStart(title: string): InboxItem {
  return {
    id: `failed-${title.length}`,
    kind: 'failed',
    title: `Couldn’t start: ${title}`,
    why: 'SAM could not get a machine: the cloud account is at its server limit. Nothing ran and nothing was charged. Retry once a node frees up, or edit the task first.',
    project: PROJECT_NAME,
    chat: 'Started from the overview',
    ageMin: 0,
    agent: 'done',
    blocking: false,
    before: [{ from: 'you', text: title }],
    since: [],
    links: [],
  };
}

export function ProjectOverviewPrototype() {
  const [params] = useSearchParams();
  const mobile = useIsMobile();
  const projectState = (
    ['normal', 'quiet', 'busy'].includes(params.get('data') ?? '') ? params.get('data') : 'normal'
  ) as ProjectState;
  const variant = params.get('variant') === '2' ? 2 : 1;
  const brief = (
    ['fresh', 'stale', 'off'].includes(params.get('brief') ?? '') ? params.get('brief') : 'fresh'
  ) as BriefState;
  const data = useMemo(() => projectData(projectState), [projectState]);

  const [state, dispatch] = useReducer(reducer, null, (): State => ({
    ...sceneState(null),
    dataset: data.inboxDataset,
    scope: params.get('screen') === 'all' ? null : PROJECT_NAME,
    openId: params.get('open'),
    filter: (params.get('filter') as Filter | null) ?? 'all',
  }));
  const [screen, setScreen] = useState<Screen>(() => {
    const s = params.get('screen') as Screen | null;
    if (s) return s;
    return params.get('open') ? (mobile ? 'item' : 'inbox') : 'overview';
  });
  const [from, setFrom] = useState<Screen>('overview');
  const [bellOpen, setBellOpen] = useState(params.get('bell') === '1');
  const [running, setRunning] = useState(data.running);
  const [receipt, setReceipt] = useState<StartReceipt>(null);
  const failNext = useRef(params.get('failNext') === '1');

  const projectView: State = { ...state, scope: PROJECT_NAME };
  const allView: State = { ...state, scope: null };
  const badge = actionable(allView).length;
  const projectCount = actionable(projectView).length;

  const go = (next: Screen) => {
    setBellOpen(false);
    if (next === 'inbox' || next === 'item') dispatch({ type: 'scope', scope: PROJECT_NAME });
    if (next === 'all') dispatch({ type: 'scope', scope: null });
    if (next === 'overview') dispatch({ type: 'open', id: null });
    setFrom(screen === 'item' ? from : screen);
    setScreen(next);
  };
  const openItem = (id: string, scope: string | null = PROJECT_NAME) => {
    setBellOpen(false);
    dispatch({ type: 'scope', scope });
    dispatch({ type: 'open', id });
    setFrom(screen === 'item' ? from : screen);
    setScreen(mobile ? 'item' : scope ? 'inbox' : 'all');
  };
  const onTarget = (t: BriefTarget) => {
    if (t.kind === 'item') openItem(t.id);
  };
  const onBell = () => (mobile ? go('all') : setBellOpen((o) => !o));
  const onStart = (text: string, profileName: string) => {
    const title = taskTitle(text);
    if (failNext.current) {
      failNext.current = false;
      dispatch({ type: 'file', item: failedStart(title) });
      setReceipt({ title, failed: true });
      return;
    }
    setRunning((r) => [startedChat(title, profileName), ...r]);
    setReceipt({ title, failed: false });
  };

  const composer = (
    <TaskComposer
      accounts={data.accounts}
      mobile={mobile}
      receipt={receipt}
      onStart={onStart}
      onOpenReceipt={() => {
        if (receipt?.failed) {
          const item = openItems(projectView).find((i) => i.kind === 'failed');
          if (item) openItem(item.id);
        } else go('chat');
      }}
      initialText={params.get('typed') === '1' ? LONG_TASK : ''}
      initialSheetOpen={params.get('sheet') === '1'}
    />
  );

  const needsYou = (
    <NeedsYou
      items={openItems(projectView)}
      count={projectCount}
      onOpen={(id) => openItem(id)}
      onAll={() => go('inbox')}
      desktop={!mobile}
    />
  );
  const rail = (
    <>
      <RunningNow running={running} onAll={() => go('chat')} onOpen={() => go('chat')} />
      <Budgets accounts={data.accounts} />
      <Automations total={data.automations.total} items={data.automations.items} />
      <Recently prs={data.mergedPrs} />
    </>
  );

  let page;
  if (screen === 'overview') {
    page = mobile ? (
      <Frame mobile>
        <PhoneBar
          title={PROJECT_NAME}
          badge={badge}
          onBell={onBell}
          action={<ChatAction onClick={() => go('chat')} />}
        />
        <div className="flex min-h-0 flex-col gap-2">
          <div className="relative min-h-0 flex-1 overflow-y-auto" data-testid="overview-scroll">
            <div className="flex flex-col gap-2">
              {variant === 1 && brief !== 'off' && (
                <Pane className="rounded-[var(--sam-radius-pane)] px-4 pt-3 pb-1">
                  <Brief project={projectState} state={brief} onTarget={onTarget} />
                </Pane>
              )}
              {needsYou}
              {variant === 2 && brief !== 'off' && (
                <Pane className="rounded-[var(--sam-radius-pane)] px-3 py-0.5">
                  <BriefLine project={projectState} state={brief} onTarget={onTarget} />
                </Pane>
              )}
              {rail}
            </div>
          </div>
          {composer}
        </div>
      </Frame>
    ) : (
      <Frame mobile={false}>
        <Sidebar
          current="overview"
          badge={badge}
          projectCount={projectCount}
          bellOpen={bellOpen}
          onBell={onBell}
          onNav={(to) => go(to === 'all-inbox' ? 'all' : to)}
        />
        <div className="relative min-h-0 overflow-y-auto" data-testid="overview-scroll">
          <div className="grid min-h-full grid-cols-[minmax(0,1fr)_minmax(320px,380px)] gap-[var(--sam-space-gutter)]">
            <div className="flex min-w-0 flex-col gap-[var(--sam-space-gutter)]">
              {brief !== 'off' && (
                <Pane className="rounded-[var(--sam-radius-pane)] px-5 pt-4 pb-1.5">
                  <Brief
                    project={projectState}
                    state={brief}
                    onTarget={onTarget}
                    heading={
                      <h1 className="m-0 mb-1 text-2xl font-bold text-fg-primary">
                        {PROJECT_NAME}
                      </h1>
                    }
                  />
                </Pane>
              )}
              {needsYou}
              <div className="sticky bottom-0 mt-auto">{composer}</div>
            </div>
            <div className="flex min-w-0 flex-col gap-[var(--sam-space-gutter)]">{rail}</div>
          </div>
        </div>
        {bellOpen && (
          <BellPopover
            state={allView}
            dispatch={dispatch}
            onClose={() => setBellOpen(false)}
            onOpenItem={(item) => openItem(item.id, null)}
            onOpenInbox={() => go('all')}
          />
        )}
      </Frame>
    );
  } else if (screen === 'chat') {
    page = mobile ? (
      <Frame mobile>
        <PhoneBar
          title={PROJECT_NAME}
          badge={badge}
          onBell={onBell}
          left={<BackButton label="Back to overview" onClick={() => go('overview')} />}
        />
        <ChatBackdrop />
      </Frame>
    ) : (
      <Frame mobile={false}>
        <Sidebar
          current="chat"
          badge={badge}
          projectCount={projectCount}
          bellOpen={false}
          onBell={onBell}
          onNav={(to) => go(to === 'all-inbox' ? 'all' : to)}
        />
        <ChatBackdrop />
      </Frame>
    );
  } else if (screen === 'item' && mobile) {
    const item = findItem(state.openId);
    page = (
      <Frame mobile>
        <Pane as="header" variant="slab" className="flex h-14 shrink-0 items-center gap-0.5 px-1">
          <BackButton
            label={from === 'overview' ? 'Back to overview' : 'Back to inbox'}
            onClick={() => go(from === 'item' ? 'overview' : from)}
          />
          <span className="flex flex-1 items-center justify-center">
            {item && <Stepper state={state} dispatch={dispatch} id={item.id} />}
          </span>
          {item && <ItemActions dispatch={dispatch} id={item.id} />}
        </Pane>
        <Pane className="flex min-h-0 flex-col rounded-[var(--sam-radius-pane)]">
          {item ? (
            <ItemPane
              state={state}
              dispatch={dispatch}
              item={item}
              advanceOnAnswer
              banner={<AdvanceReceipt state={state} item={item} />}
            />
          ) : (
            <AllDone state={state} onBack={() => go('overview')} />
          )}
        </Pane>
      </Frame>
    );
  } else {
    // The inbox list: this project's ("inbox"), or every project's ("all", from the bell).
    const scope = screen === 'all' ? null : PROJECT_NAME;
    const view: State = { ...state, scope };
    // Desktop: list plus item, so the first item in the walk is selected when none is.
    const item = mobile
      ? undefined
      : (findItem(state.openId) ?? (view.filter === 'updates' ? undefined : queue(view)[0]));
    page = mobile ? (
      <Frame mobile>
        <PhoneBar
          title={scope ? `${PROJECT_NAME} inbox` : 'Inbox'}
          badge={badge}
          onBell={onBell}
          bellActive={!scope}
          left={<BackButton label="Back to overview" onClick={() => go('overview')} />}
        />
        <Pane className="flex min-h-0 flex-col rounded-[var(--sam-radius-pane)]">
          <div className="shrink-0 px-2 pt-2 pb-1.5">
            <Filters state={view} dispatch={dispatch} />
          </div>
          <div className="relative min-h-0 flex-1 overflow-y-auto">
            <ListContent state={view} dispatch={dispatch} onOpen={(id) => openItem(id, scope)} />
          </div>
        </Pane>
      </Frame>
    ) : (
      <Frame mobile={false}>
        <Sidebar
          current={scope ? 'inbox' : 'all-inbox'}
          badge={badge}
          projectCount={projectCount}
          bellOpen={false}
          onBell={onBell}
          onNav={(to) => go(to === 'all-inbox' ? 'all' : to)}
        />
        <div className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)] gap-[var(--sam-space-gutter)]">
          <Pane
            as="header"
            variant="slab"
            className="flex flex-col gap-3 rounded-[var(--sam-radius-slab)] px-5 py-4"
          >
            <div>
              <h1 className="m-0 text-2xl font-bold text-fg-primary">Inbox</h1>
              <p className="m-0 mt-0.5 text-sm text-fg-muted">
                {scope
                  ? `What your agents need from you in ${PROJECT_NAME}.`
                  : 'What your agents need from you, across every project.'}
              </p>
            </div>
            <Filters state={view} dispatch={dispatch} />
          </Pane>
          <div className="grid min-h-0 grid-cols-[400px_minmax(0,1fr)] gap-[var(--sam-space-gutter)]">
            <Pane className="relative min-h-0 overflow-y-auto rounded-[var(--sam-radius-pane)]">
              <ListContent
                state={view}
                dispatch={dispatch}
                selectedId={item?.id}
                onOpen={(id) => openItem(id, scope)}
              />
            </Pane>
            <Pane className="flex min-h-0 flex-col rounded-[var(--sam-radius-pane)]">
              {item ? (
                <>
                  <div className="flex shrink-0 items-center justify-between border-b border-[var(--sam-hairline)] px-2 py-1">
                    <span className="flex items-center">
                      <Stepper state={view} dispatch={dispatch} id={item.id} />
                    </span>
                    <span className="flex items-center">
                      <ItemActions dispatch={dispatch} id={item.id} />
                    </span>
                  </div>
                  <div className="mx-auto flex min-h-0 w-full max-w-[680px] flex-1 flex-col">
                    <ItemPane
                      state={view}
                      dispatch={dispatch}
                      item={item}
                      advanceOnAnswer
                      banner={<AdvanceReceipt state={view} item={item} />}
                    />
                  </div>
                </>
              ) : (
                <AllDone state={view} onBack={() => go('overview')} />
              )}
            </Pane>
          </div>
        </div>
      </Frame>
    );
  }

  return <ProjectContext.Provider value={PROJECT_CONTEXT}>{page}</ProjectContext.Provider>;
}

function AllDone({ state, onBack }: { state: State; onBack: () => void }) {
  const last = state.lastReceipt ? state.resolved[state.lastReceipt] : null;
  return (
    <div className="m-auto flex flex-col items-center gap-2 px-6 py-10 text-center">
      {last && <p className="m-0 text-sm text-[var(--sam-status-success-fg)]">{last}</p>}
      <p className="m-0 text-[15px] font-semibold text-fg-primary">
        {openItems(state).length ? 'Pick an item' : 'Nothing else needs you here'}
      </p>
      <button
        type="button"
        onClick={onBack}
        className="cursor-pointer border-0 bg-transparent text-sm text-accent"
      >
        Back to the overview
      </button>
    </div>
  );
}
