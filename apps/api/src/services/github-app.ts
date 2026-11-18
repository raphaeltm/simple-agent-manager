// Moved to @simple-agent-manager/repo-hosting (worker modularization W7). Re-exported so the
// worker's existing importers are unchanged.
export {
  type AuthenticatedGitHubUser,
  ensureBranchExists,
  getAuthenticatedGitHubUser,
  getAuthenticatedUserOrganizations,
  getInstallationToken,
  getRepositoryBranches,
  getRepositoryGitmodules,
  getUserAccessibleInstallations,
  getUserInstallationRepositories,
  type GitHubRepositoryAccess,
  type UserAccessibleInstallation,
  verifyUserInstallationAccess,
  verifyWebhookSignature,
} from '@simple-agent-manager/repo-hosting';
