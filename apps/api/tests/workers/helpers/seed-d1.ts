/**
 * Shared D1 seed helpers for Miniflare integration tests.
 *
 * Centralizes user/project/installation seeding to avoid duplication
 * across DO test suites.
 */
import { env } from 'cloudflare:test';

/**
 * Seed a user into D1. Idempotent (INSERT OR IGNORE).
 */
export async function seedUser(
  userId: string,
  opts?: { githubId?: string; email?: string; name?: string },
): Promise<void> {
  const githubId = opts?.githubId ?? `gh-${userId}`;
  const email = opts?.email ?? `${userId}@test.com`;
  const name = opts?.name ?? 'Test User';

  await env.DATABASE.prepare(
    `INSERT OR IGNORE INTO users (id, github_id, email, name, created_at, updated_at)
     VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))`,
  )
    .bind(userId, githubId, email, name)
    .run();
}

/**
 * Seed a GitHub installation into D1. Idempotent.
 */
export async function seedInstallation(
  installationId: string,
  userId: string,
  opts?: { installationIdValue?: string; accountName?: string },
): Promise<void> {
  await env.DATABASE.prepare(
    `INSERT OR IGNORE INTO github_installations (id, user_id, installation_id, account_type, account_name, created_at, updated_at)
     VALUES (?, ?, ?, 'user', ?, datetime('now'), datetime('now'))`,
  )
    .bind(installationId, userId, opts?.installationIdValue ?? 'inst-12345', opts?.accountName ?? 'test-user')
    .run();
}

/**
 * Seed a project into D1. Idempotent. Requires user + installation to exist.
 */
export async function seedProject(
  projectId: string,
  userId: string,
  installationId: string,
  opts?: { name?: string; repository?: string },
): Promise<void> {
  const name = opts?.name ?? 'Test Project';
  const normalizedName = name.toLowerCase().replaceAll(/\s+/g, '-');
  const repository = opts?.repository ?? 'test-org/test-repo';

  await env.DATABASE.prepare(
    `INSERT OR IGNORE INTO projects (id, user_id, name, normalized_name, installation_id, repository, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
  )
    .bind(projectId, userId, name, normalizedName, installationId, repository, userId)
    .run();
}

/**
 * Seed a node into D1. Idempotent. Requires user to exist.
 */
export async function seedNode(
  nodeId: string,
  userId: string,
  opts?: { status?: string; vmSize?: string; vmLocation?: string; healthStatus?: string },
): Promise<void> {
  await env.DATABASE.prepare(
    `INSERT OR IGNORE INTO nodes (id, user_id, name, status, vm_size, vm_location, health_status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
  )
    .bind(
      nodeId,
      userId,
      `node-${nodeId}`,
      opts?.status ?? 'running',
      opts?.vmSize ?? 'medium',
      opts?.vmLocation ?? 'nbg1',
      opts?.healthStatus ?? 'healthy',
    )
    .run();
}

/**
 * Seed a mission into D1. Idempotent. Requires project + user to exist.
 */
export async function seedMission(
  missionId: string,
  projectId: string,
  userId: string,
  opts?: { title?: string; status?: string },
): Promise<void> {
  await env.DATABASE.prepare(
    `INSERT OR IGNORE INTO missions (id, project_id, user_id, title, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
  )
    .bind(missionId, projectId, userId, opts?.title ?? `Test mission ${missionId}`, opts?.status ?? 'planning')
    .run();
}

/**
 * Seed a task into D1. Idempotent. Requires project + user to exist.
 */
export async function seedTask(
  taskId: string,
  projectId: string,
  userId: string,
  opts?: { title?: string; status?: string },
): Promise<void> {
  await env.DATABASE.prepare(
    `INSERT OR IGNORE INTO tasks (id, project_id, user_id, title, status, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
  )
    .bind(taskId, projectId, userId, opts?.title ?? `Test task ${taskId}`, opts?.status ?? 'delegated', userId)
    .run();
}
