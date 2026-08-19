import { Alert, Breadcrumb, PageLayout, Tabs } from '@simple-agent-manager/ui';
import { useCallback, useMemo, useState } from 'react';
import { Outlet } from 'react-router';

import { useCredentials, useInvalidateCredentials } from '../hooks/useCredentials';
import { useQueryScope } from '../hooks/useQueryScope';
import { SettingsContext } from './SettingsContext';

const BASE_TABS = [
  { id: 'cloud-provider', label: 'Cloud Provider', path: 'cloud-provider' },
  { id: 'github', label: 'GitHub', path: 'github' },
  { id: 'connections', label: 'Connections', path: 'connections' },
  { id: 'agents', label: 'Agents', path: 'agents' },
  { id: 'advanced', label: 'Advanced', path: 'advanced' },
  { id: 'notifications', label: 'Notifications', path: 'notifications' },
  { id: 'usage', label: 'Usage', path: 'usage' },
];

const API_TOKENS_TAB = { id: 'api-tokens', label: 'API Tokens', path: 'api-tokens' };

/**
 * Settings shell — Tabs + Outlet for sub-route pages.
 */
export function Settings() {
  const queryScope = useQueryScope();
  const { credentials, loading, isRefreshing, error } = useCredentials(queryScope);
  const invalidateCredentials = useInvalidateCredentials(queryScope);
  const [dismissedError, setDismissedError] = useState<string | null>(null);

  // Deliberately NOT a `useCallback` closing over a toast/context object. The
  // refetch-loop incident behind `.claude/rules/48-stale-while-revalidate-ui.md`
  // started with a loader whose identity changed whenever a context re-rendered;
  // `invalidateCredentials` depends only on the query client and the scope.
  const reload = useCallback(async () => {
    setDismissedError(null);
    await invalidateCredentials();
  }, [invalidateCredentials]);

  const settingsValue = useMemo(
    () => ({ credentials, loading, isRefreshing, reload }),
    [credentials, loading, isRefreshing, reload]
  );

  const visibleError = error && error !== dismissedError ? error : null;

  const tabs = [...BASE_TABS, API_TOKENS_TAB];

  return (
    <PageLayout title="Settings" maxWidth="xl">
      <Breadcrumb
        segments={[
          { label: 'Home', path: '/dashboard' },
          { label: 'Settings' },
        ]}
      />

      {visibleError && (
        <div className="mt-3">
          <Alert variant="error" onDismiss={() => setDismissedError(visibleError)}>
            {visibleError}
          </Alert>
        </div>
      )}

      <div className="grid gap-4 mt-4">
        <Tabs tabs={tabs} basePath="/settings" />

        <SettingsContext.Provider value={settingsValue}>
          <Outlet />
        </SettingsContext.Provider>
      </div>
    </PageLayout>
  );
}
