// Moved to @simple-agent-manager/repo-hosting (worker modularization W7). Re-exported so the
// worker's existing importers are unchanged.
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
} from '@simple-agent-manager/repo-hosting';
