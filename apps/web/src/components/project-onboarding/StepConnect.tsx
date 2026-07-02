import type { GitHubInstallation, RepoProvider } from '@simple-agent-manager/shared';
import { Alert, Input } from '@simple-agent-manager/ui';
import { Link } from 'react-router';

import { BranchSelector } from '../BranchSelector';
import { RepoSelector } from '../RepoSelector';
import { Callout, StepHeader, WhyDetails } from './explain';
import type { FieldErrors } from './shared';

interface StepConnectProps {
  repoProvider: RepoProvider;
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
  onRepoSelect: (
    repo: { fullName: string; defaultBranch: string; githubRepoId?: number } | null
  ) => void;
  onBranchChange: (value: string) => void;
  onNameChange: (value: string) => void;
  onDescriptionChange: (value: string) => void;
}

function NameAndDescription({
  projectForm,
  fieldErrors,
  creatingProject,
  onNameChange,
  onDescriptionChange,
}: Readonly<
  Pick<
    StepConnectProps,
    'projectForm' | 'fieldErrors' | 'creatingProject' | 'onNameChange' | 'onDescriptionChange'
  >
>) {
  return (
    <>
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
        {fieldErrors.name && (
          <span id="project-onboarding-name-error" className="text-sm text-danger" role="alert">
            {fieldErrors.name}
          </span>
        )}
      </label>

      <label htmlFor="project-onboarding-description" className="grid gap-1.5">
        <span className="text-sm text-fg-muted">Description (optional)</span>
        <textarea
          id="project-onboarding-description"
          value={projectForm.description}
          onChange={(event) => onDescriptionChange(event.currentTarget.value)}
          rows={3}
          disabled={creatingProject}
          className="w-full resize-y rounded-md bg-inset px-3 py-2 text-sm text-fg-primary"
        />
      </label>
    </>
  );
}

export function StepConnect(props: Readonly<StepConnectProps>) {
  const {
    repoProvider,
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
  } = props;

  const isArtifacts = repoProvider === 'artifacts';

  const renderRepoSource = () => {
    if (isArtifacts) {
      return (
        <Callout variant="info">
          SAM will host this repository on Cloudflare Artifacts and seed it with a README that
          orients your agents. No GitHub account or app installation is required.
        </Callout>
      );
    }
    if (installations.length === 0) {
      return (
        <Alert variant="warning">
          Install the GitHub App in{' '}
          <Link to="/settings" className="underline">
            Settings
          </Link>{' '}
          before connecting a repository — or go back and choose SAM-hosted to start without GitHub.
        </Alert>
      );
    }
    return (
      <>
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
          {fieldErrors.repository && (
            <span
              id="project-onboarding-repository-error"
              className="text-sm text-danger"
              role="alert"
            >
              {fieldErrors.repository}
            </span>
          )}
          {fieldErrors.githubRepoId && (
            <span
              id="project-onboarding-repo-id-error"
              className="text-sm text-danger"
              role="alert"
            >
              {fieldErrors.githubRepoId}
            </span>
          )}
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
      </>
    );
  };

  return (
    <div className="grid gap-4">
      <StepHeader
        id="connect"
        title={isArtifacts ? 'Name your project' : 'Connect your code'}
        lead={
          isArtifacts
            ? 'SAM will create and host a private Git repository for this project. Agents clone it into a fresh, isolated workspace each time they run, and push their work straight back to it.'
            : 'Pick the repository and branch SAM should use when it starts work. Agents clone this repo into a fresh, isolated workspace each time they run.'
        }
      />

      <div className="grid gap-4 rounded-md border border-border-default bg-surface p-4">
        {renderRepoSource()}

        <NameAndDescription
          projectForm={projectForm}
          fieldErrors={fieldErrors}
          creatingProject={creatingProject}
          onNameChange={props.onNameChange}
          onDescriptionChange={props.onDescriptionChange}
        />
      </div>

      {submitError && <Alert variant="error">{submitError}</Alert>}

      {isArtifacts ? (
        <WhyDetails question="Where does the code live, and how do agents push?">
          <p>
            SAM provisions a private Git repository on Cloudflare Artifacts and stores its remote on
            the project. Each agent run mints a short-lived, repository-scoped token to clone and
            push — the token can only touch this one repo.
          </p>
          <p>
            There are no pull requests on a SAM-hosted repo: agents push their branch straight to
            the remote and you review the changes there. The default branch starts as{' '}
            <code>main</code>.
          </p>
        </WhyDetails>
      ) : (
        <WhyDetails question="Why does SAM need a GitHub App, and how is access scoped?">
          <p>
            SAM reaches your code through a GitHub App installation, not your personal token.
            Whenever an agent runs, SAM mints a short-lived token scoped to just this repository —
            so the App’s permissions are the hard ceiling on what any agent can ever do here.
          </p>
          <p>
            The branch you pick is the base agents branch off of. Each run works on its own branch,
            so SAM never pushes to your default branch on its own. A finished task agent auto-pushes
            that branch and opens a PR for review; a conversation agent only pushes when you ask it
            to.
          </p>
        </WhyDetails>
      )}
    </div>
  );
}
