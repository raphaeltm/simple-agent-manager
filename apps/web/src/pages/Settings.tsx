import type { CredentialResponse } from '@simple-agent-manager/shared';
import { Alert, Breadcrumb, PageLayout, Tabs } from '@simple-agent-manager/ui';
import { useCallback, useEffect, useState } from 'react';
import { Outlet } from 'react-router';

import { listCredentials } from '../lib/api';
import { SettingsContext } from './SettingsContext';

const BASE_TABS = [
  { id: 'cloud-provider', label: 'Cloud Provider', path: 'cloud-provider' },
  { id: 'github', label: 'GitHub', path: 'github' },
  { id: 'agents', label: 'Agents', path: 'agents' },
  { id: 'notifications', label: 'Notifications', path: 'notifications' },
  { id: 'usage', label: 'Usage', path: 'usage' },
];

const API_TOKENS_TAB = { id: 'api-tokens', label: 'API Tokens', path: 'api-tokens' };

/**
 * Settings shell — Tabs + Outlet for sub-route pages.
 */
export function Settings() {
  const [credentials, setCredentials] = useState<CredentialResponse[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const loadCredentials = useCallback(async () => {
    try {
      setError(null);
      const data = await listCredentials();
      setCredentials(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load credentials');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadCredentials();
  }, [loadCredentials]);

  const tabs = [...BASE_TABS, API_TOKENS_TAB];

  return (
    <PageLayout title="Settings" maxWidth="xl">
      <Breadcrumb
        segments={[
          { label: 'Home', path: '/dashboard' },
          { label: 'Settings' },
        ]}
      />

      {error && (
        <div className="mt-3">
          <Alert variant="error" onDismiss={() => setError(null)}>{error}</Alert>
        </div>
      )}

      <div className="grid gap-4 mt-4">
        <Tabs tabs={tabs} basePath="/settings" />

        <SettingsContext.Provider value={{ credentials, loading, reload: loadCredentials }}>
          <Outlet />
        </SettingsContext.Provider>
      </div>
    </PageLayout>
  );
}
