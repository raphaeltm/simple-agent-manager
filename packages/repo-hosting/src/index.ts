// Public entry point of @simple-agent-manager/repo-hosting: GitHub App and user OAuth,
// GitLab, and read-only repository browsing for the SAM API worker. Routes stay in the
// worker. Exports are what the worker imports; the port registry is the `./ports` entry.
export { type ArtifactsBinding, type RepoHostingEnv } from './env';
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
} from './github-app';
export {
  GitHubCliPolicyError,
  parseGitHubCliPolicyJson,
  resolveWorkspaceGitHubTokenOptions,
} from './github-cli-policy';
export {
  canonicalInstallationAccountUpsert,
  getCanonicalAccountInput,
  type GitHubDb,
  type GitHubInstallationAccountRow,
  normalizeAccountType,
  personalInstallationOwnerMatches,
  tombstoneCanonicalInstallationAccount,
  upsertCanonicalInstallationAccount,
} from './github-installation-accounts';
export { getExternalInstallationId, getStoredInstallationId } from './github-installation-ids';
export { bulkSweepMismatchedPersonalInstallations } from './github-installation-leak-sweep';
export { refreshGitHubAccessToken } from './github-oauth-refresh';
export {
  findProjectsForGitHubRepository,
  type GitHubProjectCandidate,
} from './github-project-repositories';
export { backfillProjectGithubRepoId, bulkBackfillGithubRepoIds } from './github-repo-id-backfill';
export {
  isDatabaseConflictError,
  summarizeAccessibleInstallations,
  summarizeInstallationRows,
} from './github-route-helpers';
export {
  getGitHubUserAccessToken,
  getGitHubUserAccessTokenForOwner,
  getGitHubUserAccessTokenWithHeaders,
} from './github-user-access-token';
export {
  ensureGitLabBranchExists,
  getGitLabUserAccessTokenForOwner,
  getGitLabUserAccessTokenResultWithHeaders,
  getGitLabUserAccessTokenWithHeaders,
  getProjectGitLabRepository,
  listGitLabBranches,
  listGitLabProjects,
  requireGitLabUserAccessToken,
  requireGitLabUserAccessTokenForOwner,
  requireGitLabUserAccessTokenResultForOwner,
  verifyGitLabProjectAccess,
} from './gitlab';
export { type RepoBrowser, resolveRepoBrowser } from './repo-browse';
