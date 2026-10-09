import { queryOptions } from '@tanstack/react-query';

import { adminConnectorSettings, connectorSettings } from '../api/connector';

/** Connector caches are identity-scoped and intentionally excluded from persistence. */
export const connectorQueryKeys = {
  all: (scope: string) => ['auth', scope, 'connector'] as const,
  settings: (scope: string) => [...connectorQueryKeys.all(scope), 'settings'] as const,
  adminSettings: (scope: string) => [...connectorQueryKeys.all(scope), 'admin-settings'] as const,
  connections: (scope: string, admin: boolean) =>
    [...connectorQueryKeys.all(scope), 'connections', admin] as const,
  clients: (scope: string) => [...connectorQueryKeys.all(scope), 'clients'] as const,
  consent: (scope: string, request: string) =>
    [...connectorQueryKeys.all(scope), 'consent', request] as const,
};
export const connectorSettingsQueryOptions = (scope: string) =>
  queryOptions({
    queryKey: connectorQueryKeys.settings(scope),
    queryFn: connectorSettings,
    enabled: Boolean(scope),
  });
export const adminConnectorSettingsQueryOptions = (scope: string) =>
  queryOptions({
    queryKey: connectorQueryKeys.adminSettings(scope),
    queryFn: adminConnectorSettings,
    enabled: Boolean(scope),
  });
