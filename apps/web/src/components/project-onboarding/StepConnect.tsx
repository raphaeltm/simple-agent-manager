import type { GitHubInstallation } from '@simple-agent-manager/shared';
import { Alert, Button, Input } from '@simple-agent-manager/ui';

import { BranchSelector } from '../BranchSelector';
import { RepoSelector } from '../RepoSelector';
import type { FieldErrors } from './shared';

interface StepConnectProps {
  installations: GitHubInstallation[];
  projectForm: {
    name: string;
    description: string;
    installationId: string;
    repository: string;
    defaultBranch: string;
    githubRepoId: number | undefined;
  };
  branches: Array<{ name: string }>;
  branchesLoading: boolean;
  branchesError: string | null;
  repoDefaultBranch: string | undefined;
  fieldErrors: FieldErrors;
  submitError: string | null;
  creatingProject: boolean;
  onInstallationChange: (id: string) => void;
  onRepositoryChange: (value: string) => void;
  onRepoSelect: (repo: { fullName: string; defaultBranch: string; githubRepoId?: number } | null) => void;
  onBranchChange: (value: string) => void;
  onNameChange: (value: string) => void;
  onDescriptionChange: (value: string) => void;
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
  onCancel: () => void;
}

export function StepConnect({
  installations,
  projectForm,
  branches,
  branchesLoading,
  branchesError,
  repoDefaultBranch,
  fieldErrors,
  submitError,
  creatingProject,
  onInstallationChange,
  onRepositoryChange,
  onRepoSelect,
  onBranchChange,
  onNameChange,
  onDescriptionChange,
  onSubmit,
  onCancel,
}: StepConnectProps) {
  return (
    <form onSubmit={onSubmit} className="grid gap-4 rounded-md border border-border-default bg-surface p-4">
      <div className="grid gap-1">
        <h2 className="text-base font-semibold text-fg-primary">Connect code</h2>
        <p className="text-sm text-fg-muted">
          Pick the repository and branch SAM should use when it starts work.
        </p>
      </div>

      <label htmlFor="project-onboarding-installation" className="grid gap-1.5">
        <span className="text-sm text-fg-muted">Installation</span>
        <select
          id="project-onboarding-installation"
          value={projectForm.installationId}
          onChange={(event) => onInstallationChange(event.currentTarget.value)}
          disabled={creatingProject}
          className="min-h-11 w-full rounded-md bg-inset px-3 py-2 text-sm text-fg-primary"
        >
          {installations.map((installation) => (
            <option key={installation.id} value={installation.id}>
              {installation.accountName} ({installation.accountType})
            </option>
          ))}
        </select>
      </label>

      <label htmlFor="project-onboarding-repository" className="grid gap-1.5">
        <span className="text-sm text-fg-muted">Repository</span>
        <RepoSelector
          id="project-onboarding-repository"
          value={projectForm.repository}
          onChange={onRepositoryChange}
          onRepoSelect={onRepoSelect}
          installationId={projectForm.installationId}
          disabled={creatingProject}
          required
        />
        {fieldErrors.repository && <span id="project-onboarding-repository-error" className="text-sm text-danger" role="alert">{fieldErrors.repository}</span>}
        {fieldErrors.githubRepoId && <span id="project-onboarding-repo-id-error" className="text-sm text-danger" role="alert">{fieldErrors.githubRepoId}</span>}
      </label>

      <label htmlFor="project-onboarding-branch" className="grid gap-1.5">
        <span className="text-sm text-fg-muted">Branch</span>
        <BranchSelector
          id="project-onboarding-branch"
          branches={branches}
          value={projectForm.defaultBranch}
          onChange={onBranchChange}
          defaultBranch={repoDefaultBranch}
          loading={branchesLoading}
          error={branchesError}
          disabled={creatingProject}
        />
      </label>

      <label htmlFor="project-onboarding-name" className="grid gap-1.5">
        <span className="text-sm text-fg-muted">Project name</span>
        <Input
          id="project-onboarding-name"
          value={projectForm.name}
          onChange={(event) => onNameChange(event.currentTarget.value)}
          disabled={creatingProject}
          placeholder="Project name"
          aria-invalid={!!fieldErrors.name}
          aria-describedby={fieldErrors.name ? 'project-onboarding-name-error' : undefined}
        />
        {fieldErrors.name && <span id="project-onboarding-name-error" className="text-sm text-danger" role="alert">{fieldErrors.name}</span>}
      </label>

      <label htmlFor="project-onboarding-description" className="grid gap-1.5">
        <span className="text-sm text-fg-muted">Description</span>
        <textarea
          id="project-onboarding-description"
          value={projectForm.description}
          onChange={(event) => onDescriptionChange(event.currentTarget.value)}
          rows={3}
          disabled={creatingProject}
          className="w-full resize-y rounded-md bg-inset px-3 py-2 text-sm text-fg-primary"
        />
      </label>

      {submitError && <Alert variant="error">{submitError}</Alert>}

      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={creatingProject}>
          {creatingProject ? 'Creating...' : 'Create project'}
        </Button>
        <Button type="button" variant="secondary" onClick={onCancel} disabled={creatingProject}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
