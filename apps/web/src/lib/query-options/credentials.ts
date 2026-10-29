import { queryOptions } from '@tanstack/react-query';

import { listCredentials } from '../api';

/**
 * The user's cloud-provider credential list (`GET /api/credentials`).
 *
 * Surfaces reading this endpoint through the shared query key: the cloud-account
 * connect step (`CloudAccountForm`), scaling settings, the project-chat state hook,
 * and the two onboarding components (`OnboardingProvider` + `ChoosePathWizard`, both
 * of which `AppShell` mounts on EVERY authenticated page).
 *
 * Still issuing its own request, tracked as follow-up: `CreateWorkspace.tsx`.
 *
 * NOT persistable. `CredentialResponse` is connection configuration, which
 * `query-persist-config.ts` places on the never-persist-without-security-review
 * list. It is deliberately absent from `PERSISTED_QUERY_OPERATIONS`.
 */
export const credentialQueryKeys = {
  all: (queryScope: string) => ['auth', queryScope, 'credentials'] as const,
  list: (queryScope: string) => [...credentialQueryKeys.all(queryScope), 'list'] as const,
};

export function credentialsQueryOptions(queryScope: string) {
  return queryOptions({
    queryKey: credentialQueryKeys.list(queryScope),
    queryFn: listCredentials,
  });
}
