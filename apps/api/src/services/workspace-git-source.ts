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

/**
 * `repository` is required so every caller passes the clone URL it already holds: resolving an
 * Artifacts project's host must not cost a D1 read on workspace creation.
 */
export type WorkspaceGitSourceProject = Pick<schema.Project, 'id' | 'repoProvider' | 'repository'>;

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

/** Cloudflare Artifacts hosts; the VM agent recognizes these by name (`gitrepo.IsArtifactsHost`). */
function isCloudflareArtifactsHost(host: string): boolean {
  return host === 'artifacts.cloudflare.net' || host.endsWith('.artifacts.cloudflare.net');
}

/**
 * An Artifacts project's clone URL is `projects.repository` (the backend's `create().remote`). For a
 * Cloudflare Artifacts remote nothing is added: the VM agent knows that host by name. A remote on
 * any other host (a self-hosted install's own git server) is bound as `repositoryHost`, the only
 * host the VM agent then attaches the workspace's git token to (`isBoundHostedArtifactsHost`).
 */
function resolveArtifactsGitSource(repository: string): WorkspaceGitSource {
  const artifactsSource: WorkspaceGitSource = {
    ...DEFAULT_GITHUB_SOURCE,
    repoProvider: 'artifacts',
  };
  let url: URL;
  try {
    // A direct-provisioning request persisted by NodeLifecycle before this field existed carries
    // no repository; `new URL(undefined)` throws, and the project keeps the Cloudflare behaviour.
    url = new URL(repository);
  } catch {
    return artifactsSource;
  }
  const host = url.host.toLowerCase();
  if (url.protocol !== 'https:' || !host || isCloudflareArtifactsHost(host)) return artifactsSource;
  return { ...artifactsSource, cloneUrl: repository, repositoryHost: host };
}

export async function resolveWorkspaceGitSource(
  db: Db,
  project: WorkspaceGitSourceProject
): Promise<WorkspaceGitSource> {
  const repoProvider = normalizeRepoProvider(project.repoProvider);
  if (repoProvider === 'artifacts') {
    return resolveArtifactsGitSource(project.repository);
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
      repository: schema.projects.repository,
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
