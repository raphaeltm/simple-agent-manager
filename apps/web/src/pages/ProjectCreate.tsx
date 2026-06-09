import type { GitHubInstallation } from '@simple-agent-manager/shared';
import { Breadcrumb, PageLayout } from '@simple-agent-manager/ui';
import { useCallback, useEffect, useState } from 'react';

import { ProjectOnboardingWizard } from '../components/project-onboarding/ProjectOnboardingWizard';
import { listGitHubInstallations } from '../lib/api';

export function ProjectCreate() {
  const [installations, setInstallations] = useState<GitHubInstallation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await listGitHubInstallations();
      setInstallations(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load installations');
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
          loading={loading}
          loadError={error}
          onRetryInstallations={load}
        />
      </div>
    </PageLayout>
  );
}
