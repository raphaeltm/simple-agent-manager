import type { Repository } from '@simple-agent-manager/shared';
import { Button, Select } from '@simple-agent-manager/ui';
import { ArrowRight, Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';

import type { StepFormState } from './step-actions';

interface ProjectSelectorProps {
  repos: Repository[];
  reposLoading: boolean;
  onLoadRepos: () => void;
  form: StepFormState;
  setForm: React.Dispatch<React.SetStateAction<StepFormState>>;
  loading: boolean;
  onCreateProject: () => void;
  onSkip?: () => void;
  tags: string[];
}

export function ProjectSelector({
  repos,
  reposLoading,
  onLoadRepos,
  form,
  setForm,
  loading,
  onCreateProject,
  onSkip,
  tags,
}: ProjectSelectorProps) {
  const navigate = useNavigate();
  const [loaded, setLoaded] = useState(false);

  // Auto-load repos on mount
  useEffect(() => {
    if (!loaded) {
      setLoaded(true);
      onLoadRepos();
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- mount-only

  if (tags.includes('use-template')) {
    return (
      <div>
        <p className="text-xs text-fg-muted mb-3">
          After setup, you can create a project from a template on the Projects page.
        </p>
        <Button
          variant="primary"
          size="md"
          onClick={() => {
            onSkip?.();
            navigate('/projects');
          }}
          disabled={loading}
        >
          Go to Projects <ArrowRight size={14} />
        </Button>
      </div>
    );
  }

  return (
    <div>
      {reposLoading ? (
        <div className="flex items-center gap-2 text-sm text-fg-muted py-3">
          <Loader2 size={14} className="animate-spin" /> Loading your repositories...
        </div>
      ) : repos.length === 0 ? (
        <div className="text-sm text-fg-muted py-3">
          <p className="mb-2">No repositories found. Make sure you've installed the GitHub App and granted repo access.</p>
          <Button variant="secondary" size="sm" onClick={onLoadRepos}>
            Refresh
          </Button>
        </div>
      ) : (
        <div className="mb-3">
          <label htmlFor="onboarding-repo-select" className="block text-xs font-medium text-fg-muted mb-1">
            Repository
          </label>
          <Select
            id="onboarding-repo-select"
            value={form.selectedRepoName}
            onChange={(e) => {
              const repo = repos.find((r) => r.fullName === e.target.value);
              setForm((prev) => ({
                ...prev,
                selectedRepoUrl: repo ? `https://github.com/${repo.fullName}.git` : '',
                selectedRepoName: repo?.fullName ?? '',
              }));
            }}
          >
            <option value="">Select a repository...</option>
            {repos.map((repo) => (
              <option key={repo.id} value={repo.fullName}>
                {repo.fullName}
              </option>
            ))}
          </Select>
        </div>
      )}
      {repos.length > 0 && (
        <Button
          variant="primary"
          size="md"
          onClick={onCreateProject}
          disabled={loading || !form.selectedRepoUrl}
        >
          {loading ? (
            <>
              <Loader2 size={14} className="animate-spin" /> Creating...
            </>
          ) : (
            <>
              Create Project <ArrowRight size={14} />
            </>
          )}
        </Button>
      )}
    </div>
  );
}
