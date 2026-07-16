import { Alert, Spinner } from '@simple-agent-manager/ui';
import { useCallback, useEffect, useState } from 'react';

import { PlatformIntegrationConfigForm } from '../components/PlatformIntegrationConfigForm';
import type { PlatformConfigStatus, PlatformIntegrationConfigInput } from '../lib/api';
import { fetchAdminPlatformConfig, updateAdminPlatformConfig } from '../lib/api';

export function AdminPlatformConfig() {
  const [status, setStatus] = useState<PlatformConfigStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadConfig = useCallback(async () => {
    setError(null);
    try {
      const response = await fetchAdminPlatformConfig();
      setStatus(response.status);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load platform integrations');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadConfig();
  }, [loadConfig]);

  const handleSave = async (config: PlatformIntegrationConfigInput) => {
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const response = await updateAdminPlatformConfig(config);
      setStatus(response.status);
      setMessage('Platform integration settings saved.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save platform integrations');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <Spinner />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="max-w-3xl">
        <p className="text-sm text-fg-muted">
          Configure runtime platform integrations. Values set here are stored in D1 and encrypted platform credentials; existing environment fallbacks remain active until overridden.
        </p>
      </div>
      {error && <Alert variant="error" onDismiss={() => setError(null)}>{error}</Alert>}
      {message && <Alert variant="success" onDismiss={() => setMessage(null)}>{message}</Alert>}
      {status && (
        <PlatformIntegrationConfigForm
          status={status}
          mode="admin"
          primaryLabel="Save integrations"
          submitting={saving}
          onPrimary={handleSave}
        />
      )}
    </div>
  );
}
