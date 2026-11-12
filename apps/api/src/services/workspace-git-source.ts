import { eq } from 'drizzle-orm';
import { type drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import { getProjectGitLabRepository } from './gitlab';

type Db = ReturnType<typeof drizzle<typeof schema>>;

export type WorkspaceGitSource = {
  repoProvider: 'github' | 'artifacts' | 'gitlab';
  cloneUrl: string | null;
  repositoryHost: string | null;
  repositoryPath: string | null;
};

export type WorkspaceGitSourceProject = Pick<schema.Project, 'id' | 'repoProvider'> &
  Partial<Pick<schema.Project, 'repository'>>;

const DEFAULT_GITHUB_SOURCE: WorkspaceGitSource = {
  repoProvider: 'github',
  cloneUrl: null,
  repositoryHost: null,
  repositoryPath: null,
};

function normalizeRepoProvider(
  repoProvider: string | null | undefined
): WorkspaceGitSource['repoProvider'] {
  switch (repoProvider) {
    case 'gitlab':
      return 'gitlab';
    case 'artifacts':
      return 'artifacts';
    default:
      return 'github';
  }
}

/** Cloudflare Artifacts hosts; the VM agent recognizes these by name (gitrepo.IsArtifactsHost). */
function isCloudflareArtifactsHost(host: string): boolean {
  return host === 'artifacts.cloudflare.net' || host.endsWith('.artifacts.cloudflare.net');
}

/**
 * An Artifacts project's clone URL is `projects.repository`. For a Cloudflare Artifacts remote
 * nothing changes (the VM agent knows the host). For a SAM-hosted repository on a self-hosted
 * install (`https://api.<BASE_DOMAIN>/git/<repo>.git`) the VM agent is told the host, so it
 * attaches the workspace's git token to the clone and its credential helper answers for it.
 */
async function resolveArtifactsGitSource(
  db: Db,
  project: WorkspaceGitSourceProject
): Promise<WorkspaceGitSource> {
  const artifactsSource: WorkspaceGitSource = { ...DEFAULT_GITHUB_SOURCE, repoProvider: 'artifacts' };
  let repository = project.repository;
  if (repository === undefined) {
    const rows = await db
      .select({ repository: schema.projects.repository })
      .from(schema.projects)
      .where(eq(schema.projects.id, project.id))
      .limit(1);
    repository = rows[0]?.repository;
  }
  let host: string | null = null;
  try {
    host = repository ? new URL(repository).host.toLowerCase() : null;
  } catch {
    host = null;
  }
  if (!host || !repository || isCloudflareArtifactsHost(host)) return artifactsSource;
  return { ...artifactsSource, cloneUrl: repository, repositoryHost: host };
}

export async function resolveWorkspaceGitSource(
  db: Db,
  project: WorkspaceGitSourceProject
): Promise<WorkspaceGitSource> {
  const repoProvider = normalizeRepoProvider(project.repoProvider);
  if (repoProvider === 'artifacts') {
    return resolveArtifactsGitSource(db, project);
  }
  if (repoProvider !== 'gitlab') {
    return {
      ...DEFAULT_GITHUB_SOURCE,
      repoProvider,
    };
  }

  const metadata = await getProjectGitLabRepository(db, project.id);
  if (!metadata) {
    throw Object.assign(
      new Error(`GitLab repository metadata is missing for project ${project.id}`),
      { permanent: true }
    );
  }

  return {
    repoProvider,
    cloneUrl: metadata.httpUrlToRepo,
    repositoryHost: metadata.host,
    repositoryPath: metadata.pathWithNamespace,
  };
}

export async function resolveWorkspaceGitSourceByProjectId(
  db: Db,
  projectId: string | null | undefined
): Promise<WorkspaceGitSource> {
  if (!projectId) {
    return DEFAULT_GITHUB_SOURCE;
  }

  const rows = await db
    .select({
      id: schema.projects.id,
      repoProvider: schema.projects.repoProvider,
    })
    .from(schema.projects)
    .where(eq(schema.projects.id, projectId))
    .limit(1);
  const project = rows[0];
  if (!project) {
    throw Object.assign(
      new Error(`Project metadata is missing for workspace project ${projectId}`),
      { permanent: true }
    );
  }

  return resolveWorkspaceGitSource(db, project);
}
