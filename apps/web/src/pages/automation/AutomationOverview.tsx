/**
 * The project's Automation page: everything that starts work on its own, problems first, in one
 * list. Replaces the separate Events and Triggers pages (audit idea 01M5CYV085D3N1Z5PZD8C5JN2D).
 */
import { useQuery } from '@tanstack/react-query';
import { Plus, Workflow } from 'lucide-react';
import { useMemo } from 'react';
import { useSearchParams } from 'react-router';

import { useIsMobile } from '../../hooks/useIsMobile';
import { useQueryScope } from '../../hooks/useQueryScope';
import { AUTOMATION_MAX_RUN_READS } from '../../lib/automation-config';
import {
  automationPaths,
  isOverviewFilter,
  type OverviewFilter,
} from '../../lib/automation-routes';
import { subscriptionsQueryOptions } from '../../lib/query-options';
import { useProjectContext } from '../ProjectContext';
import type { ActivityEntry } from './activity';
import { useAutomationAccess, useAutomationData, useAutomationLookups } from './data';
import { isManagedSubscription, isSamRelay } from './describe';
import { TEMPLATES } from './editor/templates';
import {
  AllAutomations,
  BehindTheScenesSummary,
  ComingUp,
  NeedsAttention,
  Recently,
} from './overview-sections';
import { LoadError, Loading, Notice, Page, PageHeader } from './page';
import { ButtonLink, KindIcon, Panel, SectionTitle } from './ui';

function EmptyAutomation({ canWrite }: { canWrite: boolean }) {
  const { projectId } = useProjectContext();
  return (
    <>
      <Panel
        className="flex flex-col items-center gap-4 px-6 py-10 text-center"
        label="No automation yet"
      >
        <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-[var(--sam-color-accent-primary-tint)] text-accent">
          <Workflow size={26} aria-hidden />
        </span>
        <div className="flex max-w-md flex-col gap-2">
          <h2 className="m-0 text-[19px] font-semibold text-fg-primary">
            Nothing runs on its own yet
          </h2>
          <p className="m-0 text-[15px] text-fg-muted">
            Automations start chats for you: every morning, when someone opens an issue, or when a
            release fails. You can read, reply to or stop every chat they start.
          </p>
        </div>
        {canWrite && (
          <ButtonLink to={automationPaths.create(projectId)} variant="primary">
            <Plus size={18} aria-hidden /> New automation
          </ButtonLink>
        )}
      </Panel>
      {canWrite && (
        <div className="flex flex-col gap-3">
          <SectionTitle title="Or start from an example" />
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            {TEMPLATES.map((template) => (
              <Panel key={template.id} className="flex flex-col gap-3 p-4" label={template.title}>
                <div className="flex items-center gap-3">
                  <KindIcon start={template.start} />
                  <span className="text-[15px] font-semibold text-fg-primary">
                    {template.title}
                  </span>
                </div>
                <p className="m-0 flex-1 text-sm text-fg-muted">{template.text}</p>
                <ButtonLink to={automationPaths.create(projectId, { template: template.id })}>
                  Use this
                </ButtonLink>
              </Panel>
            ))}
          </div>
        </div>
      )}
      <p className="m-0 text-[13px] text-fg-muted">
        Agents can set these up for you too: ask in any chat, for example “every weekday at 9,
        summarize open pull requests”.
      </p>
    </>
  );
}

export function AutomationOverview() {
  const { projectId } = useProjectContext();
  const queryScope = useQueryScope();
  const isMobile = useIsMobile();
  const access = useAutomationAccess();
  const lookups = useAutomationLookups(projectId);
  const data = useAutomationData(projectId);
  const [params, setParams] = useSearchParams();
  const filterParam = params.get('filter');
  const filter: OverviewFilter = isOverviewFilter(filterParam) ? filterParam : 'all';
  const waiting = useQuery({
    ...subscriptionsQueryOptions(queryScope, projectId, null, 'active'),
    enabled: Boolean(queryScope),
  });
  // Waits agents set up themselves: not SAM's relays, not a watch's own subscription.
  const waitingCount = waiting.data
    ? waiting.data.subscriptions.filter(
        (subscription) => !isSamRelay(subscription) && !isManagedSubscription(subscription)
      ).length
    : null;

  const names = useMemo(
    () => new Map(data.items.map((item) => [`${item.kind}:${item.id}`, item.name])),
    [data.items]
  );
  const nameOf = (entry: ActivityEntry) =>
    names.get(`${entry.owner.kind}:${entry.owner.id}`) ?? 'An automation';

  const header = (
    <PageHeader
      title="Automation"
      subtitle="Work that starts on its own: on a schedule, or when something happens."
      action={
        access.canWrite ? (
          <ButtonLink to={automationPaths.create(projectId)} variant="primary" className="shrink-0">
            <Plus size={18} aria-hidden />
            {isMobile ? 'New' : 'New automation'}
          </ButtonLink>
        ) : undefined
      }
    />
  );

  const notices = (
    <>
      {!access.canWrite && !access.checking && (
        <Notice>
          You can look around. Only people who can edit this project can change automation.
        </Notice>
      )}
      {data.failed.length > 0 && (
        <LoadError what={data.failed.join(', ')} onRetry={() => void data.refetch()} />
      )}
      {data.truncated && (
        <Notice>
          Showing the newest one-time automations and watches. Older finished ones are not listed.
        </Notice>
      )}
      {data.unreadRuns > 0 && (
        <Notice>
          Recent runs were checked for {AUTOMATION_MAX_RUN_READS} automations only, so a problem
          with one of the others shows on its own page, not here.
        </Notice>
      )}
    </>
  );

  if (data.isPending) {
    return (
      <Page wide>
        {header}
        <Loading label="Loading automation…" />
      </Page>
    );
  }

  if (data.items.length === 0 && data.failed.length === 0) {
    return (
      <Page>
        {header}
        {notices}
        <EmptyAutomation canWrite={access.canWrite} />
        <BehindTheScenesSummary waiting={waitingCount} hasMore={Boolean(waiting.data?.hasMore)} />
      </Page>
    );
  }

  const list = (
    <AllAutomations
      items={data.items}
      lookups={lookups}
      filter={filter}
      onFilter={(next) =>
        setParams(
          (previous) => {
            const updated = new URLSearchParams(previous);
            if (next === 'all') updated.delete('filter');
            else updated.set('filter', next);
            return updated;
          },
          { replace: true }
        )
      }
    />
  );
  const attention = <NeedsAttention items={data.items} canWrite={access.canWrite} />;
  const side = (
    <>
      <ComingUp items={data.items} lookups={lookups} />
      <Recently activity={data.activity} nameOf={nameOf} />
      <BehindTheScenesSummary waiting={waitingCount} hasMore={Boolean(waiting.data?.hasMore)} />
    </>
  );

  return (
    <Page wide>
      <div data-testid="automation-overview" className="flex flex-col gap-6">
        {header}
        {notices}
        {isMobile ? (
          <>
            {attention}
            <ComingUp items={data.items} lookups={lookups} />
            {list}
            <Recently activity={data.activity} nameOf={nameOf} />
            <BehindTheScenesSummary
              waiting={waitingCount}
              hasMore={Boolean(waiting.data?.hasMore)}
            />
          </>
        ) : (
          <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,1fr)_360px] lg:gap-8">
            <div className="flex min-w-0 flex-col gap-6">
              {attention}
              {list}
            </div>
            <div className="flex min-w-0 flex-col gap-6">{side}</div>
          </div>
        )}
      </div>
    </Page>
  );
}
