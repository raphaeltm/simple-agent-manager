/**
 * Query keys and options for the Insights page. Flow has one key per project and range, shared by the
 * Insights page and the Project Overview's "This week" pane (7 days), so opening one warms the
 * other. Not persisted (idea titles). Ranges are days long, so the read stays fresh for
 * `INSIGHTS_STALE_TIME_MS` and refetches in the background after that (stale-while-revalidate).
 */
import type { InsightsRange, InsightsSetupGrouping } from '@simple-agent-manager/shared';
import { queryOptions } from '@tanstack/react-query';

import { getProjectAccounts, getProjectFlow, getProjectPeople, getProjectSetups } from '../api';
import { INSIGHTS_STALE_TIME_MS } from '../query-stale-times';

export const insightsQueryKeys = {
  all: (queryScope: string) => ['auth', queryScope, 'insights'] as const,
  flow: (queryScope: string, projectId: string, range: InsightsRange) =>
    [...insightsQueryKeys.all(queryScope), 'flow', projectId, range] as const,
  accounts: (queryScope: string, projectId: string, range: InsightsRange) =>
    [...insightsQueryKeys.all(queryScope), 'accounts', projectId, range] as const,
  /** Every Agent setups read of one project, whatever the range and grouping. */
  setupsOfProject: (queryScope: string, projectId: string) =>
    [...insightsQueryKeys.all(queryScope), 'setups', projectId] as const,
  setups: (
    queryScope: string,
    projectId: string,
    range: InsightsRange,
    groupBy: InsightsSetupGrouping
  ) => [...insightsQueryKeys.setupsOfProject(queryScope, projectId), range, groupBy] as const,
  /** Every range of a project's People read, for invalidation after a reassign. */
  peopleAll: (queryScope: string, projectId: string) =>
    [...insightsQueryKeys.all(queryScope), 'people', projectId] as const,
  people: (queryScope: string, projectId: string, range: InsightsRange) =>
    [...insightsQueryKeys.peopleAll(queryScope, projectId), range] as const,
};

export function projectFlowQueryOptions(
  queryScope: string,
  projectId: string,
  range: InsightsRange
) {
  return queryOptions({
    queryKey: insightsQueryKeys.flow(queryScope, projectId, range),
    queryFn: () => getProjectFlow(projectId, range),
    staleTime: INSIGHTS_STALE_TIME_MS,
    // Switching range keeps the last range on screen until the new one arrives, but never
    // another project's numbers (and idea links) under this project's page.
    placeholderData: (previous) => (previous?.projectId === projectId ? previous : undefined),
  });
}

/**
 * Insights · Accounts, per project and range. Not persisted: it carries the viewer's own account
 * names and limit windows. Same stale-while-revalidate behaviour as Flow.
 */
export function projectAccountsQueryOptions(
  queryScope: string,
  projectId: string,
  range: InsightsRange
) {
  return queryOptions({
    queryKey: insightsQueryKeys.accounts(queryScope, projectId, range),
    queryFn: () => getProjectAccounts(projectId, range),
    staleTime: INSIGHTS_STALE_TIME_MS,
    placeholderData: (previous) => (previous?.projectId === projectId ? previous : undefined),
  });
}

/**
 * Insights · Agent setups, per project, range and grouping. Not persisted: it names the viewer's
 * own personal profiles and skills. Same stale-while-revalidate behaviour as Flow.
 */
export function projectSetupsQueryOptions(
  queryScope: string,
  projectId: string,
  range: InsightsRange,
  groupBy: InsightsSetupGrouping
) {
  return queryOptions({
    queryKey: insightsQueryKeys.setups(queryScope, projectId, range, groupBy),
    queryFn: () => getProjectSetups(projectId, range, groupBy),
    staleTime: INSIGHTS_STALE_TIME_MS,
    placeholderData: (previous) => (previous?.projectId === projectId ? previous : undefined),
  });
}

/**
 * Insights · People, per project and range. Not persisted: it carries the titles of the inbox items
 * the viewer may open. Same stale-while-revalidate behaviour as Flow.
 */
export function projectPeopleQueryOptions(
  queryScope: string,
  projectId: string,
  range: InsightsRange
) {
  return queryOptions({
    queryKey: insightsQueryKeys.people(queryScope, projectId, range),
    queryFn: () => getProjectPeople(projectId, range),
    staleTime: INSIGHTS_STALE_TIME_MS,
    placeholderData: (previous) => (previous?.projectId === projectId ? previous : undefined),
  });
}
