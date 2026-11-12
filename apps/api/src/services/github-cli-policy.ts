// Moved to @simple-agent-manager/repo-hosting (worker modularization W7). Re-exported so the
// worker's existing importers are unchanged.
export {
  GitHubCliPolicyError,
  type GitHubCliPolicyParseResult,
  GitHubCliPolicySchema,
  type GitHubInstallationTokenOptions,
  parseGitHubCliPolicyJson,
  resolveWorkspaceGitHubTokenOptions,
  toInstallationTokenOptions,
} from '@simple-agent-manager/repo-hosting';
