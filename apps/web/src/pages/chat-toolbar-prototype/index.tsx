/**
 * Prototype harness for the chat tool-strip explorations.
 *
 * Mounts the REAL production surface — `SessionHeader`, `AcpConversationItemView`
 * (via the shared acp-client bubbles), `ProjectChatComposer`, and the real
 * `useFloatingHeaderHeight` measurement — against mock data, per project policy
 * "Use real UI components for prototypes when exploring production surfaces"
 * (231a944e). The only new code is the two tool-strip variations themselves.
 *
 * The page owns a `100vh` scroll container because SAM scrolls inside the app shell
 * rather than at the document level (policy 63006482).
 *
 * Query params:
 *   - `variant`  — `rail` (A, default) | `dock` (B) | `none` (today's production baseline)
 *   - `mode`     — `icons` (default) | `labels` | `hidden`
 *   - `state`    — `sleeping` (default) | `active` | `idle` | `terminated`
 *   - `long`     — any value uses the long-title / long-token stress data
 *   - `empty`    — any value renders the empty conversation
 *   - `comments` — integer, unresolved comment count driving the badge
 *   - `chrome`   — `0` hides the interactive scenario switcher (for screenshots)
 *
 * NOT linked from navigation. Dev/test only — see `DEV_ONLY_ROUTE_PATHS` in App.tsx.
 */
import type { ConversationItem } from '@simple-agent-manager/acp-client';
import { useCallback, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';

import { ProjectChatComposer } from '../../components/project-chat/ProjectChatComposer';
import { AcpConversationItemView } from '../../components/project-message-view/AcpConversationItemView';
import { useFloatingHeaderHeight } from '../../components/project-message-view/MessageListScaffold';
import { SessionHeader } from '../../components/project-message-view/SessionHeader';
import type { SessionState } from '../../components/project-message-view/types';
import { useIsMobile } from '../../hooks/useIsMobile';
import {
  EMPTY_CONVERSATION,
  makeConversation,
  makeNode,
  makePorts,
  makeSession,
  makeWorkspace,
  MOCK_PROJECT_ID,
} from './mock-data';
import { ScenarioSwitcher } from './ScenarioSwitcher';
import { buildToolActions, type ToolStripMode } from './tool-actions';
import { ToolDock } from './ToolDock';
import { railGutter, ToolRail } from './ToolRail';

const VALID_MODES: ToolStripMode[] = ['icons', 'labels', 'hidden'];
const VALID_STATES: SessionState[] = ['active', 'idle', 'sleeping', 'terminated'];

/** Repeat the mock conversation so the list is tall enough to exercise scroll. */
function fillConversation(base: ConversationItem[], repeats: number): ConversationItem[] {
  return Array.from({ length: repeats }, (_, r) =>
    base.map((item) => ({ ...item, id: `${item.id}-r${r}` }) as ConversationItem)
  ).flat();
}

export function ChatToolbarPrototype() {
  const [params, setParams] = useSearchParams();

  const paramVariant = params.get('variant');
  // `none` reproduces production exactly — no strip at all, every tool still buried
  // behind the header chevron. It is the honest "before" baseline for comparison.
  const variant: 'rail' | 'dock' | 'none' =
    paramVariant === 'dock' ? 'dock' : paramVariant === 'none' ? 'none' : 'rail';
  const paramMode = params.get('mode') as ToolStripMode | null;
  const urlMode: ToolStripMode = paramMode && VALID_MODES.includes(paramMode) ? paramMode : 'icons';
  const paramState = params.get('state') as SessionState | null;
  const sessionState: SessionState =
    paramState && VALID_STATES.includes(paramState) ? paramState : 'sleeping';
  const long = params.get('long') != null;
  const empty = params.get('empty') != null;
  const showChrome = params.get('chrome') !== '0';
  const commentCount = Math.max(0, Number(params.get('comments') ?? '2') || 0);

  // Mode is URL-driven so Playwright can address every state, but a click updates
  // the URL too — the strip stays interactive without a second source of truth.
  const setMode = useCallback(
    (next: ToolStripMode) => {
      const updated = new URLSearchParams(params);
      updated.set('mode', next);
      setParams(updated, { replace: true });
    },
    [params, setParams]
  );

  const [composerValue, setComposerValue] = useState('');
  const [lastAction, setLastAction] = useState<string | null>(null);
  const [headerRef, headerHeight] = useFloatingHeaderHeight();
  const isMobile = useIsMobile();

  const session = useMemo(() => makeSession({ long, state: sessionState }), [long, sessionState]);
  const workspace = useMemo(() => makeWorkspace(), []);
  const node = useMemo(() => makeNode(), []);
  const ports = useMemo(() => makePorts(3), []);
  const conversation = useMemo(
    () => (empty ? EMPTY_CONVERSATION : fillConversation(makeConversation({ long }), 2)),
    [empty, long]
  );

  const actions = useMemo(
    () =>
      buildToolActions({
        session,
        sessionState,
        taskEmbed: session.task ?? null,
        // Real header reads this from `getReportIssueConfig()`; forced on here so the
        // prototype shows the widest realistic tool set.
        reportEnabled: true,
        unresolvedCommentCount: commentCount,
      }),
    [session, sessionState, commentCount]
  );

  const onSelect = useCallback((id: string) => setLastAction(id), []);

  const gutter = variant === 'rail' ? railGutter(urlMode, isMobile) : 0;

  return (
    <div className="h-screen flex flex-col bg-canvas text-fg-primary overflow-hidden">
      <div data-testid="harness-scenario" className="sr-only">
        {`variant=${variant} mode=${urlMode} state=${sessionState} long=${long} empty=${empty} comments=${commentCount}`}
      </div>

      {/* Chat pane — mirrors `ProjectMessageView`'s relative container so the header
          floats over the list and the rail can be offset by the measured height. */}
      <div className="flex-1 min-h-0 relative">
        <div ref={headerRef} className="absolute top-0 left-0 right-0 z-10">
          <SessionHeader
            projectId={MOCK_PROJECT_ID}
            session={session}
            sessionState={sessionState}
            loading={false}
            idleCountdownMs={sessionState === 'idle' ? 7 * 60 * 1000 : null}
            taskEmbed={session.task ?? null}
            workspace={workspace}
            node={node}
            detectedPorts={ports}
            onOpenFiles={() => setLastAction('files')}
            onOpenGit={() => setLastAction('git')}
            onOpenTimeline={() => setLastAction('timeline')}
            onOpenComments={() => setLastAction('comments')}
            unresolvedCommentCount={commentCount}
            needsAttentionCommentCount={commentCount > 0 ? 1 : 0}
            onRetry={() => setLastAction('retry')}
            onFork={() => setLastAction('fork')}
            initialPromptFallback="Where did the running tasks come from, and what is each one actually doing right now?"
          />
        </div>

        <div
          data-testid="prototype-message-list"
          className="absolute inset-0 overflow-y-auto px-4"
          style={{ paddingTop: headerHeight + 12, paddingRight: gutter + 16, paddingBottom: 16 }}
        >
          {conversation.length === 0 ? (
            <div className="h-full flex items-center justify-center text-center">
              <p className="text-sm text-fg-muted max-w-xs">
                No messages yet. Send a message to wake the agent.
              </p>
            </div>
          ) : (
            conversation.map((item) => (
              <AcpConversationItemView key={item.id} item={item} projectId={MOCK_PROJECT_ID} />
            ))
          )}
        </div>

        {variant === 'rail' && (
          <ToolRail
            actions={actions}
            mode={urlMode}
            onModeChange={setMode}
            onSelect={onSelect}
            top={headerHeight}
            isMobile={isMobile}
          />
        )}
      </div>

      {variant === 'dock' && (
        <ToolDock actions={actions} mode={urlMode} onModeChange={setMode} onSelect={onSelect} />
      )}

      <div className="relative shrink-0 glass-chrome border-x-0 border-b-0 px-4 py-3">
        <ProjectChatComposer
          value={composerValue}
          onChange={setComposerValue}
          onSend={() => setComposerValue('')}
          sending={false}
          placeholder={
            sessionState === 'sleeping'
              ? 'Send a message to wake the agent...'
              : 'Send a follow-up message...'
          }
          transcribeApiUrl="https://api.sammy.party/api/transcribe"
          showShortcutHint={false}
        />
      </div>

      {showChrome && (
        <ScenarioSwitcher
          params={params}
          setParams={setParams}
          lastAction={lastAction}
          onClearAction={() => setLastAction(null)}
        />
      )}
    </div>
  );
}
