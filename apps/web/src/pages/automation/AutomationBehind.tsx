/**
 * "Behind the scenes": what agents set up for themselves. Two tabs: what they are waiting for
 * (event subscriptions) and the channels they post on. With `?sessionId=` it shows everything
 * that concerns one chat instead (the old chat-scoped Events links land here).
 */
import { DEFAULT_PROJECT_EVENT_LIST_MAX } from '@simple-agent-manager/shared';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useSearchParams } from 'react-router';

import { useQueryScope } from '../../hooks/useQueryScope';
import { automationPaths, type BehindTab, projectChatPath } from '../../lib/automation-routes';
import { subscriptionsQueryOptions } from '../../lib/query-options';
import { useProjectContext } from '../ProjectContext';
import { Channels } from './channels';
import { ChatAutomation } from './chat-automation';
import { useAutomationAccess, useAutomationLookups } from './data';
import { CheckRow } from './fields';
import { LoadError, Loading, Notice, Page, PageHeader } from './page';
import { ButtonLink, Chips } from './ui';
import { WaitList } from './waiting';

function Waiting() {
  const { projectId } = useProjectContext();
  const queryScope = useQueryScope();
  const access = useAutomationAccess();
  const lookups = useAutomationLookups(projectId);
  const [showEnded, setShowEnded] = useState(false);
  const active = useQuery({
    ...subscriptionsQueryOptions(queryScope, projectId, null, 'active'),
    enabled: Boolean(queryScope),
  });
  // Ended waits are history; they are read only when someone asks for them.
  const all = useQuery({
    ...subscriptionsQueryOptions(queryScope, projectId, null, 'any'),
    enabled: Boolean(queryScope) && showEnded,
  });
  const ended = (all.data?.subscriptions ?? []).filter(
    (subscription) => subscription.state !== 'active'
  );
  return (
    <div className="flex flex-col gap-4">
      <p className="m-0 text-sm text-fg-muted">
        Agents ask SAM to tell them when something happens, like CI finishing or a review arriving.
        When it does, SAM wakes their chat with the news.
      </p>
      {active.isPending ? (
        <Loading />
      ) : active.isError ? (
        <LoadError
          what="what agents are waiting for"
          error={active.error}
          onRetry={() => void active.refetch()}
        />
      ) : (
        <>
          <WaitList
            subscriptions={active.data.subscriptions}
            lookups={lookups}
            canWrite={access.canWrite}
            emptyText="No agent is waiting on anything right now."
          />
          {active.data.hasMore && (
            <Notice>
              Showing the most recent {DEFAULT_PROJECT_EVENT_LIST_MAX}. Open a chat’s automation
              panel to see all of its waits.
            </Notice>
          )}
        </>
      )}
      <CheckRow checked={showEnded} onChange={setShowEnded} label="Show waits that ended" />
      {showEnded &&
        (all.isPending ? (
          <Loading />
        ) : all.isError ? (
          <LoadError what="ended waits" error={all.error} onRetry={() => void all.refetch()} />
        ) : (
          <WaitList
            subscriptions={ended}
            lookups={lookups}
            canWrite={false}
            emptyText="Nothing has ended recently."
          />
        ))}
    </div>
  );
}

export function AutomationBehind() {
  const { projectId } = useProjectContext();
  const lookups = useAutomationLookups(projectId);
  const [params, setParams] = useSearchParams();
  const sessionId = params.get('sessionId');
  const tab: BehindTab = params.get('tab') === 'channels' ? 'channels' : 'waiting';
  const back = { label: 'Automation', to: automationPaths.overview(projectId) };

  if (sessionId) {
    return (
      <Page>
        <PageHeader
          back={back}
          title={`Automation for “${lookups.chatTitle(sessionId)}”`}
          subtitle="What this chat is waiting for, and what is set to message it."
        />
        <div className="flex flex-wrap gap-3">
          <ButtonLink to={projectChatPath(projectId, sessionId)}>Open the chat</ButtonLink>
          <ButtonLink to={automationPaths.behind(projectId)}>Show the whole project</ButtonLink>
        </div>
        <ChatAutomation sessionId={sessionId} />
      </Page>
    );
  }

  return (
    <Page>
      <PageHeader
        back={back}
        title="Behind the scenes"
        subtitle="What agents set up for themselves."
      />
      <Chips
        label="Show"
        value={tab}
        onChange={(next) =>
          setParams(
            (previous) => {
              const updated = new URLSearchParams(previous);
              if (next === 'channels') updated.set('tab', 'channels');
              else updated.delete('tab');
              return updated;
            },
            { replace: true }
          )
        }
        options={[
          { id: 'waiting', label: 'Waiting for' },
          { id: 'channels', label: 'Channels' },
        ]}
      />
      {tab === 'channels' ? <Channels lookups={lookups} /> : <Waiting />}
    </Page>
  );
}
