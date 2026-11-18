// Moved to @simple-agent-manager/repo-hosting (worker modularization W7). Re-exported so the
// worker's existing importers are unchanged.
export {
  findProjectsForGitHubRepository,
  type GitHubProjectCandidate,
} from '@simple-agent-manager/repo-hosting';
