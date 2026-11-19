// Moved to @simple-agent-manager/repo-hosting (worker modularization W7). Re-exported so the
// worker's existing importers are unchanged.
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
} from '@simple-agent-manager/repo-hosting';
