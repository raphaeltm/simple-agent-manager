// Public entry point of @simple-agent-manager/repo-hosting: GitHub App and user OAuth,
// GitLab, and read-only repository browsing for the SAM API worker. Routes stay in the
// worker; the worker supplies platform config and Better Auth access through ports.
export type { Env, RepoHostingEnv, RepoHostingRequestContext } from './env';
export {
  type AuthenticatedGitHubUser,
  DEFAULT_GITHUB_INSTALLATION_TOKEN_CACHE_TTL_SECONDS,
  DEFAULT_GITHUB_INSTALLATION_TOKEN_REFRESH_MARGIN_SECONDS,
  ensureBranchExists,
  type EnsureBranchOutcome,
  generateAppJWT,
  getAuthenticatedGitHubUser,
  getAuthenticatedUserOrganizations,
  getInstallationAccount,
  getInstallationRepositories,
  getInstallationToken,
  getRepositoryBranches,
  getRepositoryGitmodules,
  getRepositoryMetadata,
  getUserAccessibleInstallations,
  getUserInstallationRepositories,
  GITHUB_REPOSITORY_MAX_PAGE,
  GITHUB_REPOSITORY_PAGE_SIZE,
  GITHUB_REPOSITORY_SCAN_LIMIT,
  type GitHubRepositoryAccess,
  type GitHubRepositoryMetadata,
  type GitHubUserOrganization,
  type GitmoduleEntry,
  type InstallationAccount,
  MAX_GITHUB_INSTALLATION_TOKEN_REFRESH_MARGIN_SECONDS,
  parseGitmodules,
  type UserAccessibleInstallation,
  verifyUserInstallationAccess,
  verifyWebhookSignature,
} from './github-app';
export {
  GitHubCliPolicyError,
  type GitHubCliPolicyParseResult,
  GitHubCliPolicySchema,
  type GitHubInstallationTokenOptions,
  parseGitHubCliPolicyJson,
  resolveWorkspaceGitHubTokenOptions,
  toInstallationTokenOptions,
} from './github-cli-policy';
export {
  type CanonicalInstallationAccountInput,
  canonicalInstallationAccountUpsert,
  getCanonicalAccountInput,
  type GitHubDb,
  type GitHubInstallationAccountRow,
  normalizeAccountName,
  normalizeAccountType,
  personalInstallationOwnerMatches,
  tombstoneCanonicalInstallationAccount,
  upsertCanonicalInstallationAccount,
} from './github-installation-accounts';
export {
  getExternalInstallationId,
  getStoredInstallationId,
  type GitHubInstallationReference,
} from './github-installation-ids';
export {
  bulkSweepMismatchedPersonalInstallations,
  type LeakSweepSummary,
} from './github-installation-leak-sweep';
export { refreshGitHubAccessToken } from './github-oauth-refresh';
export {
  findProjectsForGitHubRepository,
  type GitHubProjectCandidate,
} from './github-project-repositories';
export {
  backfillProjectGithubRepoId,
  type BackfillResult,
  type BackfillStatus,
  bulkBackfillGithubRepoIds,
  type BulkBackfillSummary,
} from './github-repo-id-backfill';
export {
  getTokenType,
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
  compareGitLabRefs,
  ensureGitLabBranchExists,
  getGitLabFile,
  getGitLabProject,
  getGitLabRawFile,
  getGitLabTree,
  getGitLabUserAccessToken,
  getGitLabUserAccessTokenForOwner,
  getGitLabUserAccessTokenResultWithHeaders,
  getGitLabUserAccessTokenWithHeaders,
  getProjectGitLabRepository,
  type GitLabAccessTokenResult,
  type GitLabRepositoryMetadata,
  listGitLabBranches,
  listGitLabProjects,
  requireGitLabUserAccessToken,
  requireGitLabUserAccessTokenForOwner,
  requireGitLabUserAccessTokenResultForOwner,
  type StoredGitLabRepositoryMetadata,
  verifyGitLabProjectAccess,
} from './gitlab';
export {
  type AuthPort,
  configureRepoHostingPort,
  configureRepoHostingPorts,
  type GitHubAppConfig,
  type GitHubOAuthConfig,
  type GitLabOAuthConfig,
  type PlatformConfigPort,
  type RepoHostingPorts,
  repoHostingPorts,
} from './ports';
export { type RepoBrowser, resolveRepoBrowser } from './repo-browse';
export {
  availableUserAccessToken,
  requestLockedUserAccessToken,
  userAccessTokenExpiryIso,
  type UserAccessTokenResult,
} from './user-access-token';
