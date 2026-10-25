/**
 * Query keys and options for the project Automation page.
 *
 * Keys follow the barrel's invariant, `['auth', queryScope, 'automation', operation, projectId,
 * …]`. None is persisted: schedules, watches and subscriptions carry prompts and chat ids, and
 * channel history carries agent-written text.
 *
 * The trigger list itself stays on `triggerQueryKeys` (shared with the chat sidebar's trigger
 * popover and the chat header), so a change made here shows there without a second fetch.
 */
import {
  AGENT_MESSAGE_CHANNEL_PREFIX,
  DEFAULT_PROJECT_EVENT_LIST_MAX,
  DIRECT_CHANNEL_RANGE_END,
  type ProjectEventChannel,
  type ProjectEventSubscriptionState,
  type ProjectSchedule,
  type ProjectStandingWatch,
} from '@simple-agent-manager/shared';
import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query';

import { getTrigger, listTriggerExecutions, listWebhookDeliveries } from '../api';
import {
  AUTOMATION_MAX_CHANNEL_PAGES,
  AUTOMATION_MAX_LIST_PAGES,
  AUTOMATION_RUNS_PAGE_SIZE,
} from '../automation-config';
import {
  getEventChannelHistory,
  getSchedule,
  getStandingWatch,
  listEventChannels,
  listEventSubscriptionDeliveries,
  listEventSubscriptions,
  listSchedules,
  listStandingWatches,
} from '../project-events-api';

const key = (queryScope: string, operation: string, projectId: string) =>
  ['auth', queryScope, 'automation', operation, projectId] as const;

export const automationQueryKeys = {
  all: (queryScope: string) => ['auth', queryScope, 'automation'] as const,
  trigger: (queryScope: string, projectId: string, triggerId: string) =>
    [...key(queryScope, 'trigger', projectId), triggerId] as const,
  /** A few recent runs of one trigger, for the overview and History. */
  recentRuns: (queryScope: string, projectId: string, triggerId: string, limit: number) =>
    [...key(queryScope, 'recent-runs', projectId), triggerId, limit] as const,
  /** Every page of one trigger's runs, for its own page. */
  runPages: (queryScope: string, projectId: string, triggerId: string) =>
    [...key(queryScope, 'run-pages', projectId), triggerId] as const,
  webhookDeliveries: (queryScope: string, projectId: string, triggerId: string) =>
    [...key(queryScope, 'webhook-deliveries', projectId), triggerId] as const,
  schedules: (queryScope: string, projectId: string, sessionId: string | null) =>
    [...key(queryScope, 'schedules', projectId), sessionId] as const,
  schedule: (queryScope: string, projectId: string, scheduleId: string) =>
    [...key(queryScope, 'schedule', projectId), scheduleId] as const,
  watches: (queryScope: string, projectId: string, sessionId: string | null) =>
    [...key(queryScope, 'watches', projectId), sessionId] as const,
  watch: (queryScope: string, projectId: string, watchId: string) =>
    [...key(queryScope, 'watch', projectId), watchId] as const,
  subscriptions: (
    queryScope: string,
    projectId: string,
    sessionId: string | null,
    state: ProjectEventSubscriptionState | 'any'
  ) => [...key(queryScope, 'subscriptions', projectId), sessionId, state] as const,
  subscriptionDeliveries: (queryScope: string, projectId: string, subscriptionId: string) =>
    [...key(queryScope, 'subscription-deliveries', projectId), subscriptionId] as const,
  channels: (queryScope: string, projectId: string, includeDirect: boolean) =>
    [...key(queryScope, 'channels', projectId), includeDirect] as const,
  channelHistory: (queryScope: string, projectId: string, channel: string) =>
    [...key(queryScope, 'channel-history', projectId), channel] as const,
};

/** A bounded read of a cursor-paged list: every page up to the cap, and whether it stopped early. */
export type BoundedList<T> = { items: T[]; truncated: boolean };

async function readPages<T>(
  maxPages: number,
  fetchPage: (cursor: string | null) => Promise<{ items: T[]; nextCursor: string | null }>
): Promise<BoundedList<T>> {
  const items: T[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < maxPages; page++) {
    const result = await fetchPage(cursor);
    items.push(...result.items);
    if (!result.nextCursor) return { items, truncated: false };
    cursor = result.nextCursor;
  }
  return { items, truncated: true };
}

export function triggerDetailQueryOptions(
  queryScope: string,
  projectId: string,
  triggerId: string
) {
  return queryOptions({
    queryKey: automationQueryKeys.trigger(queryScope, projectId, triggerId),
    queryFn: () => getTrigger(projectId, triggerId),
  });
}

export function recentRunsQueryOptions(
  queryScope: string,
  projectId: string,
  triggerId: string,
  limit: number
) {
  return queryOptions({
    queryKey: automationQueryKeys.recentRuns(queryScope, projectId, triggerId, limit),
    queryFn: async () => (await listTriggerExecutions(projectId, triggerId, { limit })).executions,
    // One request per trigger already; a failing API should not multiply them. Pages say
    // when some runs could not be loaded.
    retry: 1,
  });
}

/** The executions endpoint pages by offset; its `nextCursor` is the next offset. */
export function runPagesQueryOptions(queryScope: string, projectId: string, triggerId: string) {
  return infiniteQueryOptions({
    queryKey: automationQueryKeys.runPages(queryScope, projectId, triggerId),
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      listTriggerExecutions(projectId, triggerId, {
        limit: AUTOMATION_RUNS_PAGE_SIZE,
        offset: pageParam,
      }),
    getNextPageParam: (last) => {
      const next = Number.parseInt(last.nextCursor ?? '', 10);
      return Number.isFinite(next) ? next : undefined;
    },
  });
}

export function webhookDeliveriesQueryOptions(
  queryScope: string,
  projectId: string,
  triggerId: string
) {
  return infiniteQueryOptions({
    queryKey: automationQueryKeys.webhookDeliveries(queryScope, projectId, triggerId),
    initialPageParam: '',
    queryFn: ({ pageParam }) => listWebhookDeliveries(projectId, triggerId, pageParam || undefined),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

export function schedulesQueryOptions(
  queryScope: string,
  projectId: string,
  sessionId: string | null = null
) {
  return queryOptions({
    queryKey: automationQueryKeys.schedules(queryScope, projectId, sessionId),
    queryFn: (): Promise<BoundedList<ProjectSchedule>> =>
      readPages(AUTOMATION_MAX_LIST_PAGES, async (cursor) => {
        const page = await listSchedules(
          projectId,
          cursor,
          sessionId ?? undefined,
          DEFAULT_PROJECT_EVENT_LIST_MAX
        );
        return { items: page.schedules, nextCursor: page.nextCursor };
      }),
  });
}

export function scheduleDetailQueryOptions(queryScope: string, projectId: string, id: string) {
  return queryOptions({
    queryKey: automationQueryKeys.schedule(queryScope, projectId, id),
    queryFn: async () => (await getSchedule(projectId, id)).schedule,
  });
}

export function watchesQueryOptions(
  queryScope: string,
  projectId: string,
  sessionId: string | null = null
) {
  return queryOptions({
    queryKey: automationQueryKeys.watches(queryScope, projectId, sessionId),
    queryFn: (): Promise<BoundedList<ProjectStandingWatch>> =>
      readPages(AUTOMATION_MAX_LIST_PAGES, async (cursor) => {
        const page = await listStandingWatches(
          projectId,
          cursor,
          sessionId ?? undefined,
          DEFAULT_PROJECT_EVENT_LIST_MAX
        );
        return { items: page.watches, nextCursor: page.nextCursor };
      }),
  });
}

export function watchDetailQueryOptions(queryScope: string, projectId: string, id: string) {
  return queryOptions({
    queryKey: automationQueryKeys.watch(queryScope, projectId, id),
    queryFn: async () => (await getStandingWatch(projectId, id)).watch,
  });
}

/** One page of the API's largest size: subscriptions have no cursor (`hasMore` only). */
export function subscriptionsQueryOptions(
  queryScope: string,
  projectId: string,
  sessionId: string | null,
  state: ProjectEventSubscriptionState | 'any' = 'any'
) {
  return queryOptions({
    queryKey: automationQueryKeys.subscriptions(queryScope, projectId, sessionId, state),
    queryFn: () =>
      listEventSubscriptions(
        projectId,
        sessionId ?? undefined,
        state,
        DEFAULT_PROJECT_EVENT_LIST_MAX
      ),
  });
}

export function subscriptionDeliveriesQueryOptions(
  queryScope: string,
  projectId: string,
  subscriptionId: string
) {
  return queryOptions({
    queryKey: automationQueryKeys.subscriptionDeliveries(queryScope, projectId, subscriptionId),
    queryFn: () => listEventSubscriptionDeliveries(projectId, subscriptionId),
    retry: false,
  });
}

export const isDirectChannel = (name: string) => name.startsWith(AGENT_MESSAGE_CHANNEL_PREFIX);

export type ChannelCatalog = BoundedList<ProjectEventChannel> & {
  /** Agent-to-agent channels seen and left out (a lower bound when the range was skipped). */
  directSeen: number;
};

/**
 * The channel catalog, newest activity first. The API orders by name, so this reads the whole
 * catalog (bounded) and sorts locally. Without `includeDirect`, SAM's agent-to-agent relays are
 * left out and their name range is skipped.
 */
export function channelsQueryOptions(
  queryScope: string,
  projectId: string,
  includeDirect: boolean
) {
  return queryOptions({
    queryKey: automationQueryKeys.channels(queryScope, projectId, includeDirect),
    queryFn: async (): Promise<ChannelCatalog> => {
      const channels: ProjectEventChannel[] = [];
      let directSeen = 0;
      let cursor: string | null = null;
      for (let page = 0; page < AUTOMATION_MAX_CHANNEL_PAGES; page++) {
        const result = await listEventChannels(projectId, cursor, DEFAULT_PROJECT_EVENT_LIST_MAX);
        for (const channel of result.channels) {
          if (!includeDirect && isDirectChannel(channel.name)) directSeen++;
          else channels.push(channel);
        }
        const last = result.channels.at(-1)?.name;
        if (!result.nextCursor)
          return { items: sortByActivity(channels), truncated: false, directSeen };
        cursor =
          !includeDirect && last && isDirectChannel(last) && last < DIRECT_CHANNEL_RANGE_END
            ? DIRECT_CHANNEL_RANGE_END
            : result.nextCursor;
      }
      return { items: sortByActivity(channels), truncated: true, directSeen };
    },
  });
}

function sortByActivity(channels: ProjectEventChannel[]) {
  return [...channels].sort((a, b) => b.lastPublishedAt - a.lastPublishedAt);
}

export function channelHistoryQueryOptions(queryScope: string, projectId: string, channel: string) {
  return infiniteQueryOptions({
    queryKey: automationQueryKeys.channelHistory(queryScope, projectId, channel),
    initialPageParam: '',
    queryFn: ({ pageParam }) => getEventChannelHistory(projectId, channel, pageParam || null),
    getNextPageParam: (last) => (last.hasMore ? last.cursor : undefined),
    retry: false,
  });
}
