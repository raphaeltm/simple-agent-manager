import type { Repository } from '@simple-agent-manager/shared';
import { Button, Select } from '@simple-agent-manager/ui';
import { ArrowRight, Loader2 } from 'lucide-react';
import { useCallback, useRef } from 'react';

import type { StepFormState } from './step-actions';

interface ProjectSelectorProps {
  repos: Repository[];
  reposLoading: boolean;
  onLoadRepos: () => void;
  form: StepFormState;
  setForm: React.Dispatch<React.SetStateAction<StepFormState>>;
  loading: boolean;
  onCreateProject: () => void;
}

export function ProjectSelector({
  repos,
  reposLoading,
  onLoadRepos,
  form,
  setForm,
  loading,
  onCreateProject,
}: ProjectSelectorProps) {
  const loadedRef = useRef(false);
  // Trigger repo loading once when the selector mounts via ref callback
  const containerRef = useCallback(
    (el: HTMLDivElement | null) => {
      if (el && !loadedRef.current) {
        loadedRef.current = true;
        onLoadRepos();
      }
    },
    [onLoadRepos]
  );

  return (
    <div ref={containerRef}>
      {reposLoading ? (
        <div className="flex items-center gap-2 text-sm text-fg-muted py-3">
          <Loader2 size={14} className="animate-spin" /> Loading your repositories...
        </div>
      ) : repos.length === 0 ? (
        <div className="text-sm text-fg-muted py-3">
          <p className="mb-2">No repositories found. Make sure you&apos;ve installed the GitHub App and granted repo access.</p>
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
            disabled={loading}
            onChange={(e) => {
              const repo = repos.find((r) => r.fullName === e.target.value);
              if (repo) {
                setForm((prev) => ({ ...prev, selectedRepoName: repo.fullName }));
              } else {
                setForm((prev) => ({ ...prev, selectedRepoName: '' }));
              }
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
          disabled={loading || !form.selectedRepoName}
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
