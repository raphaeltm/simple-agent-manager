import { useState, useEffect, useCallback } from 'react';
import { Outlet } from 'react-router-dom';
import { listCredentials } from '../lib/api';
import type { CredentialResponse } from '@simple-agent-manager/shared';
import { Alert, Breadcrumb, PageLayout, Tabs } from '@simple-agent-manager/ui';
import { UserMenu } from '../components/UserMenu';
import { SettingsContext } from './SettingsContext';

const SETTINGS_TABS = [
  { id: 'cloud-provider', label: 'Cloud Provider', path: 'cloud-provider' },
  { id: 'github', label: 'GitHub', path: 'github' },
  { id: 'agent-keys', label: 'Agent Keys', path: 'agent-keys' },
  { id: 'agent-config', label: 'Agent Config', path: 'agent-config' },
];

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

  return (
    <PageLayout title="Settings" maxWidth="xl" headerRight={<UserMenu />}>
      <Breadcrumb
        segments={[
          { label: 'Dashboard', path: '/dashboard' },
          { label: 'Settings' },
        ]}
      />

      {error && (
        <div style={{ marginTop: 'var(--sam-space-3)' }}>
          <Alert variant="error" onDismiss={() => setError(null)}>{error}</Alert>
        </div>
      )}

      <div style={{ display: 'grid', gap: 'var(--sam-space-4)', marginTop: 'var(--sam-space-4)' }}>
        <Tabs tabs={SETTINGS_TABS} basePath="/settings" />

        <SettingsContext.Provider value={{ credentials, loading, reload: loadCredentials }}>
          <Outlet />
        </SettingsContext.Provider>
      </div>
    </PageLayout>
  );
}
