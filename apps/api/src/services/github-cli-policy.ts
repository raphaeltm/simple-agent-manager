import type { GitHubCliPermissionLevel, GitHubCliPolicy } from '@simple-agent-manager/shared';
import { and, desc, eq, isNull, or } from 'drizzle-orm';
import { type drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import { log } from '../lib/logger';

type Db = ReturnType<typeof drizzle<typeof schema>>;

export interface GitHubInstallationTokenOptions {
  repositoryIds?: number[];
  permissions?: Record<string, 'read' | 'write'>;
}

interface WorkspacePolicyInput {
  workspaceId: string;
  projectId: string;
  userId: string;
  githubRepoId: number | null;
}

export class GitHubCliPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitHubCliPolicyError';
  }
}

const permissionNames = {
  contents: 'contents',
  pullRequests: 'pull_requests',
  issues: 'issues',
  actions: 'actions',
  packages: 'packages',
} as const;

function parsePolicy(raw: string | null): GitHubCliPolicy | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as GitHubCliPolicy;
    if (
      parsed?.mode === 'custom' &&
      parsed.repositoryScope === 'project' &&
      parsed.permissions &&
      (parsed.permissions.contents === 'read' || parsed.permissions.contents === 'write')
    ) {
      return parsed;
    }
  } catch (err) {
    log.warn('github_cli_policy.parse_failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    throw new GitHubCliPolicyError('Invalid GitHub CLI policy JSON');
  }
  throw new GitHubCliPolicyError('Invalid GitHub CLI policy shape');
}

function includePermission(
  target: Record<string, 'read' | 'write'>,
  githubName: string,
  level: GitHubCliPermissionLevel
) {
  if (level === 'read' || level === 'write') {
    target[githubName] = level;
  }
}

export function toInstallationTokenOptions(
  policy: GitHubCliPolicy | null,
  githubRepoId: number | null
): GitHubInstallationTokenOptions | null {
  if (!policy || policy.mode !== 'custom') return null;
  if (!githubRepoId) {
    throw new GitHubCliPolicyError('Project-scoped GitHub CLI policy requires githubRepoId');
  }
  const repositoryId = githubRepoId;

  const permissions: Record<string, 'read' | 'write'> = {
    [permissionNames.contents]: policy.permissions.contents,
  };
  includePermission(permissions, permissionNames.pullRequests, policy.permissions.pullRequests);
  includePermission(permissions, permissionNames.issues, policy.permissions.issues);
  includePermission(permissions, permissionNames.actions, policy.permissions.actions);
  includePermission(permissions, permissionNames.packages, policy.permissions.packages);

  return {
    repositoryIds: [repositoryId],
    permissions,
  };
}

export async function resolveWorkspaceGitHubTokenOptions(
  db: Db,
  input: WorkspacePolicyInput
): Promise<GitHubInstallationTokenOptions | null> {
  const taskRows = await db
    .select({ profileId: schema.tasks.agentProfileHint })
    .from(schema.tasks)
    .where(
      and(
        eq(schema.tasks.workspaceId, input.workspaceId),
        eq(schema.tasks.projectId, input.projectId),
        eq(schema.tasks.userId, input.userId)
      )
    )
    .orderBy(desc(schema.tasks.createdAt))
    .limit(1);

  const profileId = taskRows[0]?.profileId;
  if (!profileId) return null;

  const profileRows = await db
    .select({ githubCliPolicy: schema.agentProfiles.githubCliPolicy })
    .from(schema.agentProfiles)
    .where(
      and(
        eq(schema.agentProfiles.id, profileId),
        eq(schema.agentProfiles.userId, input.userId),
        or(
          eq(schema.agentProfiles.projectId, input.projectId),
          isNull(schema.agentProfiles.projectId)
        )
      )
    )
    .limit(1);

  const policy = parsePolicy(profileRows[0]?.githubCliPolicy ?? null);
  return toInstallationTokenOptions(policy, input.githubRepoId);
}
