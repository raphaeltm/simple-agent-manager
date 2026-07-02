import type { GitHubInstallation } from '@simple-agent-manager/shared';
import { Breadcrumb, PageLayout } from '@simple-agent-manager/ui';
import { useCallback, useEffect, useState } from 'react';

import { ProjectOnboardingWizard } from '../components/project-onboarding';
import { getArtifactsEnabled, listGitHubInstallations } from '../lib/api';

export function ProjectCreate() {
  const [installations, setInstallations] = useState<GitHubInstallation[]>([]);
  const [artifactsEnabled, setArtifactsEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setLoadError(null);
      setLoading(true);
      const [data, artifacts] = await Promise.all([listGitHubInstallations(), getArtifactsEnabled()]);
      setInstallations(data);
      setArtifactsEnabled(artifacts);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Failed to load installations');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <PageLayout title="New Project" maxWidth="xl">
      <Breadcrumb
        segments={[
          { label: 'Home', path: '/dashboard' },
          { label: 'Projects', path: '/projects' },
          { label: 'New Project' },
        ]}
      />

      <div className="mt-4">
        <ProjectOnboardingWizard
          installations={installations}
          artifactsEnabled={artifactsEnabled}
          loading={loading}
          loadError={loadError}
          onRetryInstallations={load}
        />
      </div>
    </PageLayout>
  );
}
