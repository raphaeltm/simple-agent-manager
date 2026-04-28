/**
 * Shared helpers for SAM agent tools.
 *
 * Extracts common patterns: project ownership verification, GitHub token resolution.
 */
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../../../db/schema';
import type { Env } from '../../../env';
import { log } from '../../../lib/logger';
import { getCredentialEncryptionKey } from '../../../lib/secrets';
import { decrypt } from '../../../services/encryption';
import type { ToolContext } from '../types';

/** Minimal project fields needed for ownership-verified operations. */
export interface OwnedProject {
  id: string;
  repository: string;
  defaultBranch: string;
  installationId: string | null;
}

/**
 * Verify that a project exists and is owned by the current user.
 * Returns the project or null if not found / not owned.
 */
export async function resolveProjectWithOwnership(
  projectId: string,
  ctx: ToolContext,
): Promise<OwnedProject | null> {
  const db = drizzle(ctx.env.DATABASE as D1Database, { schema });

  const [project] = await db
    .select({
      id: schema.projects.id,
      repository: schema.projects.repository,
      defaultBranch: schema.projects.defaultBranch,
      installationId: schema.projects.installationId,
    })
    .from(schema.projects)
    .where(
      and(
        eq(schema.projects.id, projectId),
        eq(schema.projects.userId, ctx.userId),
      ),
    )
    .limit(1);

  return project ?? null;
}

const REPO_FORMAT_RE = /^[\w.-]+\/[\w.-]+$/;

/**
 * Validate and parse a repository string into owner/repo components.
 * Returns null if the format is invalid.
 */
export function parseRepository(repository: string): { owner: string; repo: string } | null {
  if (!REPO_FORMAT_RE.test(repository)) return null;
  const parts = repository.split('/');
  const owner = parts[0];
  const repo = parts[1];
  if (!owner || !repo) return null;
  return { owner, repo };
}

/**
 * Get the user's GitHub token from encrypted credentials.
 * Returns null if not available.
 */
export async function getUserGitHubToken(
  userId: string,
  env: Env,
): Promise<string | null> {
  try {
    const db = drizzle(env.DATABASE, { schema });
    const [cred] = await db
      .select({
        encryptedToken: schema.credentials.encryptedToken,
        iv: schema.credentials.iv,
      })
      .from(schema.credentials)
      .where(
        and(
          eq(schema.credentials.userId, userId),
          eq(schema.credentials.provider, 'github'),
          eq(schema.credentials.isActive, true),
        ),
      )
      .limit(1);

    if (!cred) return null;

    const encryptionKey = getCredentialEncryptionKey(env);
    return await decrypt(cred.encryptedToken, cred.iv, encryptionKey);
  } catch (e) {
    log.warn('sam.helpers.github_token_failed', { userId, error: String(e) });
    return null;
  }
}
