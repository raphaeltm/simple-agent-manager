/**
 * Query keys for the Deployments pages.
 *
 * Keys follow the barrel's invariant, `['auth', queryScope, 'deployments', operation,
 * projectId, …]`. None is persisted: environments carry server error text, logs carry app
 * output, and settings carry values the app reads.
 */
const key = (queryScope: string, operation: string, projectId: string) =>
  ['auth', queryScope, 'deployments', operation, projectId] as const;

export const deploymentQueryKeys = {
  /** Every Deployments query: mutations refresh these, few and cheap. */
  all: (queryScope: string) => ['auth', queryScope, 'deployments'] as const,
  environments: (queryScope: string, projectId: string) =>
    key(queryScope, 'environments', projectId),
  /** One part of one environment: releases, config, domains, volumes, logs, … */
  environment: (queryScope: string, projectId: string, part: string, envId: string | undefined) =>
    [...key(queryScope, part, projectId), envId] as const,
  /** The chat (task) behind a release, for its title. */
  task: (queryScope: string, projectId: string, taskId: string | null | undefined) =>
    [...key(queryScope, 'task', projectId), taskId] as const,
};
