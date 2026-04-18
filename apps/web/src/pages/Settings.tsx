import type { CredentialResponse } from '@simple-agent-manager/shared';
import { Alert, Breadcrumb, PageLayout, Tabs } from '@simple-agent-manager/ui';
import { useCallback,useEffect, useState } from 'react';
import { Outlet } from 'react-router';

import { UserMenu } from '../components/UserMenu';
import { getSmokeTestStatus,listCredentials } from '../lib/api';
import { SettingsContext } from './SettingsContext';

const BASE_TABS = [
  { id: 'cloud-provider', label: 'Cloud Provider', path: 'cloud-provider' },
  { id: 'github', label: 'GitHub', path: 'github' },
  { id: 'agents', label: 'Agents', path: 'agents' },
  { id: 'notifications', label: 'Notifications', path: 'notifications' },
  { id: 'usage', label: 'Usage', path: 'usage' },
];

const SMOKE_TEST_TAB = { id: 'smoke-test-tokens', label: 'Test Tokens', path: 'smoke-test-tokens' };

/**
 * Settings shell — Tabs + Outlet for sub-route pages.
 */
export function Settings() {
  const [credentials, setCredentials] = useState<CredentialResponse[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [smokeTestEnabled, setSmokeTestEnabled] = useState(false);

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
    getSmokeTestStatus()
      .then((status) => setSmokeTestEnabled(status.enabled))
      .catch(() => setSmokeTestEnabled(false));
  }, [loadCredentials]);

  const tabs = smokeTestEnabled ? [...BASE_TABS, SMOKE_TEST_TAB] : BASE_TABS;

  return (
    <PageLayout title="Settings" maxWidth="xl" headerRight={<UserMenu />}>
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
