import type { GitHubCliPermissionLevel, GitHubCliPolicy } from '@simple-agent-manager/shared';
import { and, eq, isNull, or } from 'drizzle-orm';
import { type drizzle } from 'drizzle-orm/d1';
import * as v from 'valibot';

import * as schema from '../db/schema';
import { log } from '../lib/logger';

type Db = ReturnType<typeof drizzle<typeof schema>>;

export interface GitHubInstallationTokenOptions {
  repositoryIds?: number[];
  permissions?: Record<string, 'read' | 'write'>;
}

interface WorkspacePolicyInput {
  workspaceId: string;
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

const GitHubCliPermissionLevelSchema = v.picklist(['none', 'read', 'write']);
const GitHubCliContentsPermissionLevelSchema = v.picklist(['read', 'write']);

/**
 * Canonical shape of a stored `agent_profiles.github_cli_policy` JSON value.
 * Mirrors the write-time `GitHubCliPolicySchema` in
 * `apps/api/src/schemas/agent-profiles.ts` — the only writer of this column —
 * so every row this application has ever written parses successfully here.
 * This is the single parser shared by this file and `agent-profiles.ts`; each
 * caller applies its own error-handling contract on top (see `parsePolicy`
 * below and `parseGitHubCliPolicy` in `agent-profiles.ts`).
 */
export const GitHubCliPolicySchema = v.object({
  mode: v.picklist(['inherit', 'custom']),
  repositoryScope: v.literal('project'),
  permissions: v.object({
    contents: GitHubCliContentsPermissionLevelSchema,
    pullRequests: GitHubCliPermissionLevelSchema,
    issues: GitHubCliPermissionLevelSchema,
    actions: GitHubCliPermissionLevelSchema,
    packages: GitHubCliPermissionLevelSchema,
  }),
});

export type GitHubCliPolicyParseResult =
  | { kind: 'ok'; policy: GitHubCliPolicy }
  | { kind: 'invalid_json'; error: string }
  | { kind: 'invalid_shape' };

/**
 * Parse a stored `github_cli_policy` JSON column value (already known to be a
 * non-null string). Never throws — the JSON-syntax-error and shape-mismatch
 * cases are reported separately so callers can log/fail exactly as they did
 * before this parser was shared.
 */
export function parseGitHubCliPolicyJson(raw: string): GitHubCliPolicyParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { kind: 'invalid_json', error: err instanceof Error ? err.message : String(err) };
  }
  const result = v.safeParse(GitHubCliPolicySchema, parsed);
  return result.success ? { kind: 'ok', policy: result.output } : { kind: 'invalid_shape' };
}

/**
 * Resolve the policy used for GitHub CLI token scoping. Fails closed: any
 * non-null raw value that isn't a `mode: 'custom'` policy (bad JSON, wrong
 * shape, or `mode: 'inherit'` — which is never actually stored, see
 * `serializeGitHubCliPolicy` in `agent-profiles.ts`) throws rather than
 * silently falling back to full installation-token access.
 */
function parsePolicy(raw: string | null): GitHubCliPolicy | null {
  if (!raw) return null;
  const result = parseGitHubCliPolicyJson(raw);
  if (result.kind === 'invalid_json') {
    log.warn('github_cli_policy.parse_failed', { error: result.error });
    throw new GitHubCliPolicyError('Invalid GitHub CLI policy JSON');
  }
  if (result.kind === 'invalid_shape' || result.policy.mode !== 'custom') {
    throw new GitHubCliPolicyError('Invalid GitHub CLI policy shape');
  }
  return result.policy;
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
  // Read the profile hint directly from the workspace record.
  // This avoids the D1 tasks table FK constraint issue for DO-only projects.
  const wsRows = await db
    .select({
      agentProfileHint: schema.workspaces.agentProfileHint,
      projectId: schema.workspaces.projectId,
    })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, input.workspaceId))
    .limit(1);

  const profileId = wsRows[0]?.agentProfileHint;
  const projectId = wsRows[0]?.projectId;
  if (!profileId || !projectId) return null;

  const profileRows = await db
    .select({ githubCliPolicy: schema.agentProfiles.githubCliPolicy })
    .from(schema.agentProfiles)
    .where(
      and(
        eq(schema.agentProfiles.id, profileId),
        eq(schema.agentProfiles.userId, input.userId),
        or(eq(schema.agentProfiles.projectId, projectId), isNull(schema.agentProfiles.projectId))
      )
    )
    .limit(1);

  const policy = parsePolicy(profileRows[0]?.githubCliPolicy ?? null);
  return toInstallationTokenOptions(policy, input.githubRepoId);
}
