// =============================================================================
// GitLab
// =============================================================================

export interface GitLabProject {
  id: number;
  pathWithNamespace: string;
  name: string;
  private: boolean;
  defaultBranch: string;
  webUrl: string | null;
  httpUrlToRepo: string | null;
}

export interface GitLabProjectListResponse {
  projects: GitLabProject[];
}
