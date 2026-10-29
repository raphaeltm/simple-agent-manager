import { queryOptions } from '@tanstack/react-query';

import {
  getResolutionStatus,
  listCCAttachments,
  listCCConfigurations,
  listCCCredentials,
} from '../api';

/**
 * Connected accounts — the composable-credential primitives behind Settings →
 * Agents / Infrastructure and Project settings → Accounts.
 *
 * Every write that changes which account a project uses (connect, replace,
 * disconnect, project override, rename, remove) touches several of these rows at
 * once, so callers invalidate `accountQueryKeys.all` rather than a single list.
 *
 * `resolutionStatus` is fetched first by `useAccountsData`: the route lazily
 * backfills the cc_* tables from legacy credentials, so reading the lists before
 * it would show an empty account list to a user who has only legacy credentials.
 *
 * NOT persistable: credential names and attachment topology are credential
 * metadata, so none of these operations is on `PERSISTED_QUERY_OPERATIONS`
 * (`query-persist-config.ts`); `query-persistence-allowlist.test.ts` pins that.
 */
export const accountQueryKeys = {
  all: (queryScope: string) => ['auth', queryScope, 'accounts'] as const,
  resolutionStatus: (queryScope: string, projectId?: string) =>
    [...accountQueryKeys.all(queryScope), 'resolution-status', projectId ?? null] as const,
  credentials: (queryScope: string) =>
    [...accountQueryKeys.all(queryScope), 'credentials'] as const,
  configurations: (queryScope: string) =>
    [...accountQueryKeys.all(queryScope), 'configurations'] as const,
  attachments: (queryScope: string) =>
    [...accountQueryKeys.all(queryScope), 'attachments'] as const,
};

export function resolutionStatusQueryOptions(queryScope: string, projectId?: string) {
  return queryOptions({
    queryKey: accountQueryKeys.resolutionStatus(queryScope, projectId),
    queryFn: () => getResolutionStatus(projectId),
  });
}

export function ccCredentialsQueryOptions(queryScope: string) {
  return queryOptions({
    queryKey: accountQueryKeys.credentials(queryScope),
    queryFn: listCCCredentials,
  });
}

export function ccConfigurationsQueryOptions(queryScope: string) {
  return queryOptions({
    queryKey: accountQueryKeys.configurations(queryScope),
    queryFn: listCCConfigurations,
  });
}

export function ccAttachmentsQueryOptions(queryScope: string) {
  return queryOptions({
    queryKey: accountQueryKeys.attachments(queryScope),
    queryFn: listCCAttachments,
  });
}
