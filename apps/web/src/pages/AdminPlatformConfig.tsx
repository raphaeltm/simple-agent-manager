import { Alert, Spinner } from '@simple-agent-manager/ui';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { AdminAgentEmailPanel } from '../components/AdminAgentEmailPanel';
import { AdminConnectorPanel } from '../components/AdminConnectorPanel';
import { PlatformIntegrationConfigForm } from '../components/PlatformIntegrationConfigForm';
import { useQueryScope } from '../hooks/useQueryScope';
import type { PlatformIntegrationConfigInput } from '../lib/api';
import { fetchAdminPlatformConfig, listProjects, updateAdminPlatformConfig } from '../lib/api';
import { PROJECT_LIST_LIMIT } from '../lib/project-query-config';

export function AdminPlatformConfig() {
  const scope = useQueryScope();
  const client = useQueryClient();
  const queryKey = ['auth', scope, 'admin', 'platform-config'] as const;
  const config = useQuery({
    queryKey,
    queryFn: ({ signal }) => fetchAdminPlatformConfig(signal),
    enabled: Boolean(scope),
  });
  // Fetch additional project pages only when requested by the user.
  const projects = useInfiniteQuery({
    queryKey: ['auth', scope, 'admin', 'feedback-project-options'],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ signal, pageParam }) => listProjects(PROJECT_LIST_LIMIT, pageParam, signal),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: Boolean(scope && config.data),
  });
  const status = config.data?.status;
  const feedbackProjects = projects.data?.pages.flatMap((page) => page.projects) ?? [];
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleSave = async (config: PlatformIntegrationConfigInput) => {
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      await client.cancelQueries({ queryKey: queryKey, exact: true });
      const response = await updateAdminPlatformConfig(config);
      client.setQueryData(queryKey, response);
      setMessage('Platform integration settings saved.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save platform integrations');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="max-w-3xl">
        <p className="text-sm text-fg-muted">
          Configure runtime platform integrations. Values set here are stored in D1 and encrypted
          platform credentials; existing environment fallbacks remain active until overridden.
        </p>
      </div>
      {config.isPending && (
        <div className="flex justify-center py-12">
          <Spinner />
        </div>
      )}
      {config.error && <Alert variant="error">{config.error.message}</Alert>}
      {error && (
        <Alert variant="error" onDismiss={() => setError(null)}>
          {error}
        </Alert>
      )}
      {message && (
        <Alert variant="success" onDismiss={() => setMessage(null)}>
          {message}
        </Alert>
      )}
      {status && (
        <PlatformIntegrationConfigForm
          status={status}
          mode="admin"
          primaryLabel="Save integrations"
          submitting={saving}
          onPrimary={handleSave}
          feedbackProjects={feedbackProjects}
          feedbackProjectsFooter={
            <>
              {projects.error && <Alert variant="error">{projects.error.message}</Alert>}
              {projects.isError && !projects.data && (
                <button
                  type="button"
                  className="text-sm text-accent min-h-11"
                  disabled={projects.isFetching}
                  onClick={() => void projects.refetch()}
                >
                  Retry project list
                </button>
              )}
              {projects.hasNextPage && (
                <button
                  type="button"
                  disabled={projects.isFetchingNextPage}
                  className="text-sm text-accent min-h-11"
                  onClick={() => void projects.fetchNextPage()}
                >
                  {projects.isFetchingNextPage ? 'Loading projects...' : 'Load more projects'}
                </button>
              )}
            </>
          }
        />
      )}
      <AdminConnectorPanel />
      <AdminAgentEmailPanel />
    </div>
  );
}
