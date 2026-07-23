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
  opts?: { githubId?: string; email?: string; name?: string }
): Promise<void> {
  const githubId = opts?.githubId ?? `gh-${userId}`;
  const email = opts?.email ?? `${userId}@test.com`;
  const name = opts?.name ?? 'Test User';

  await env.DATABASE.prepare(
    `INSERT OR IGNORE INTO users (id, github_id, email, name, created_at, updated_at)
     VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))`
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
  opts?: { installationIdValue?: string; accountName?: string }
): Promise<void> {
  const externalInstallationId = opts?.installationIdValue ?? 'inst-12345';
  const accountName = opts?.accountName ?? 'test-user';

  await env.DATABASE.prepare(
    `INSERT OR IGNORE INTO github_installation_accounts
       (installation_id, account_type, account_name, normalized_account_name, created_at, updated_at)
     VALUES (?, 'personal', ?, lower(?), datetime('now'), datetime('now'))`
  )
    .bind(externalInstallationId, accountName, accountName)
    .run();

  await env.DATABASE.prepare(
    `INSERT OR IGNORE INTO github_installations (id, user_id, installation_id, external_installation_id, account_type, account_name, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'user', ?, datetime('now'), datetime('now'))`
  )
    .bind(installationId, userId, externalInstallationId, externalInstallationId, accountName)
    .run();
}

/**
 * Seed a project into D1. Idempotent. Requires user + installation to exist.
 */
export async function seedProject(
  projectId: string,
  userId: string,
  installationId: string,
  opts?: { name?: string; repository?: string }
): Promise<void> {
  const name = opts?.name ?? 'Test Project';
  const normalizedName = name.toLowerCase().replaceAll(/\s+/g, '-');
  const repository = opts?.repository ?? 'test-org/test-repo';

  await env.DATABASE.prepare(
    `INSERT OR IGNORE INTO projects (id, user_id, name, normalized_name, installation_id, repository, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
  )
    .bind(projectId, userId, name, normalizedName, installationId, repository, userId)
    .run();

  await env.DATABASE.prepare(
    `INSERT OR IGNORE INTO project_members
       (project_id, user_id, role, status, invited_by, created_at, updated_at)
     VALUES (?, ?, 'owner', 'active', ?, datetime('now'), datetime('now'))`
  )
    .bind(projectId, userId, userId)
    .run();
}

/**
 * Seed a node into D1. Idempotent. Requires user to exist.
 */
export async function seedNode(
  nodeId: string,
  userId: string,
  opts?: {
    status?: string;
    vmSize?: string;
    vmLocation?: string;
    healthStatus?: string;
    warmSince?: string | null;
    createdAt?: string;
    updatedAt?: string;
    lastHeartbeatAt?: string | null;
    nodeClass?: 'managed' | 'user-owned';
  }
): Promise<void> {
  await env.DATABASE.prepare(
    `INSERT OR IGNORE INTO nodes (id, user_id, name, status, vm_size, vm_location, health_status, warm_since, last_heartbeat_at, node_class, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      nodeId,
      userId,
      `node-${nodeId}`,
      opts?.status ?? 'running',
      opts?.vmSize ?? 'medium',
      opts?.vmLocation ?? 'nbg1',
      opts?.healthStatus ?? 'healthy',
      opts?.warmSince ?? null,
      opts?.lastHeartbeatAt ?? null,
      opts?.nodeClass ?? 'managed',
      opts?.createdAt ?? new Date().toISOString(),
      opts?.updatedAt ?? new Date().toISOString()
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
  opts?: { title?: string; status?: string }
): Promise<void> {
  await env.DATABASE.prepare(
    `INSERT OR IGNORE INTO missions (id, project_id, user_id, title, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
  )
    .bind(
      missionId,
      projectId,
      userId,
      opts?.title ?? `Test mission ${missionId}`,
      opts?.status ?? 'planning'
    )
    .run();
}

/**
 * Seed a task into D1. Idempotent. Requires project + user to exist.
 */
export async function seedTask(
  taskId: string,
  projectId: string,
  userId: string,
  opts?: {
    title?: string;
    status?: string;
    workspaceId?: string;
    autoProvisionedNodeId?: string;
    executionStep?: string;
    taskMode?: string;
    startedAt?: string;
    updatedAt?: string;
  }
): Promise<void> {
  const updatedAt = opts?.updatedAt ?? new Date().toISOString();
  await env.DATABASE.prepare(
    `INSERT OR IGNORE INTO tasks (id, project_id, user_id, title, status, workspace_id, auto_provisioned_node_id, execution_step, task_mode, started_at, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)`
  )
    .bind(
      taskId,
      projectId,
      userId,
      opts?.title ?? `Test task ${taskId}`,
      opts?.status ?? 'delegated',
      opts?.workspaceId ?? null,
      opts?.autoProvisionedNodeId ?? null,
      opts?.executionStep ?? null,
      opts?.taskMode ?? 'task',
      opts?.startedAt ?? null,
      userId,
      updatedAt
    )
    .run();
}

/**
 * Seed a workspace into D1. Idempotent. Requires user + node to exist.
 */
export async function seedWorkspace(
  workspaceId: string,
  nodeId: string | null,
  userId: string,
  opts?: {
    projectId?: string;
    status?: string;
    chatSessionId?: string;
    createdAt?: string;
    updatedAt?: string;
  }
): Promise<void> {
  await env.DATABASE.prepare(
    `INSERT OR IGNORE INTO workspaces (id, node_id, user_id, project_id, name, repository, branch, status, vm_size, vm_location, chat_session_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'main', ?, 'medium', 'nbg1', ?, ?, ?)`
  )
    .bind(
      workspaceId,
      nodeId,
      userId,
      opts?.projectId ?? null,
      `ws-${workspaceId}`,
      'test-org/test-repo',
      opts?.status ?? 'running',
      opts?.chatSessionId ?? null,
      opts?.createdAt ?? new Date().toISOString(),
      opts?.updatedAt ?? new Date().toISOString()
    )
    .run();
}

/**
 * Seed a compute_usage record into D1. Idempotent. Requires user to exist.
 */
export async function seedComputeUsage(
  id: string,
  userId: string,
  workspaceId: string,
  nodeId: string,
  opts?: { startedAt?: string; endedAt?: string | null }
): Promise<void> {
  await env.DATABASE.prepare(
    `INSERT OR IGNORE INTO compute_usage (id, user_id, workspace_id, node_id, server_type, vcpu_count, credential_source, started_at, ended_at, created_at)
     VALUES (?, ?, ?, ?, 'cx22', 2, 'user', ?, ?, datetime('now'))`
  )
    .bind(
      id,
      userId,
      workspaceId,
      nodeId,
      opts?.startedAt ?? new Date().toISOString(),
      opts?.endedAt ?? null
    )
    .run();
}

/**
 * Seed a trigger into D1. Idempotent. Requires project + user to exist.
 */
export async function seedTrigger(
  triggerId: string,
  projectId: string,
  userId: string,
  opts?: {
    name?: string;
    status?: string;
    sourceType?: string;
    cronExpression?: string;
    cronTimezone?: string;
    skipIfRunning?: boolean;
    promptTemplate?: string;
    maxConcurrent?: number;
    triggerCount?: number;
    nextFireAt?: string | null;
    lastTriggeredAt?: string | null;
    taskMode?: string;
  }
): Promise<void> {
  await env.DATABASE.prepare(
    `INSERT OR IGNORE INTO triggers
      (id, project_id, user_id, name, status, source_type, cron_expression, cron_timezone,
       skip_if_running, prompt_template, max_concurrent, trigger_count, next_fire_at,
       last_triggered_at, task_mode, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
  )
    .bind(
      triggerId,
      projectId,
      userId,
      opts?.name ?? `Trigger ${triggerId}`,
      opts?.status ?? 'active',
      opts?.sourceType ?? 'cron',
      opts?.cronExpression ?? '0 9 * * *',
      opts?.cronTimezone ?? 'UTC',
      opts?.skipIfRunning === false ? 0 : 1,
      opts?.promptTemplate ?? 'Review PRs for {{trigger.name}}',
      opts?.maxConcurrent ?? 1,
      opts?.triggerCount ?? 0,
      opts?.nextFireAt ?? new Date(Date.now() - 60_000).toISOString(),
      opts?.lastTriggeredAt ?? null,
      opts?.taskMode ?? 'task'
    )
    .run();
}

/**
 * Seed a trigger execution into D1. Idempotent. Requires trigger to exist.
 */
export async function seedTriggerExecution(
  executionId: string,
  triggerId: string,
  projectId: string,
  opts?: {
    status?: string;
    taskId?: string | null;
    eventType?: string;
    skipReason?: string | null;
    errorMessage?: string | null;
    renderedPrompt?: string | null;
    scheduledAt?: string | null;
    startedAt?: string | null;
    completedAt?: string | null;
    sequenceNumber?: number;
    createdAt?: string;
  }
): Promise<void> {
  await env.DATABASE.prepare(
    `INSERT OR IGNORE INTO trigger_executions
      (id, trigger_id, project_id, status, task_id, event_type, skip_reason,
       error_message, rendered_prompt, scheduled_at, started_at, completed_at,
       sequence_number, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      executionId,
      triggerId,
      projectId,
      opts?.status ?? 'running',
      opts?.taskId ?? null,
      opts?.eventType ?? 'cron',
      opts?.skipReason ?? null,
      opts?.errorMessage ?? null,
      opts?.renderedPrompt ?? null,
      opts?.scheduledAt ?? null,
      opts?.startedAt ?? opts?.createdAt ?? new Date().toISOString(),
      opts?.completedAt ?? null,
      opts?.sequenceNumber ?? 1,
      opts?.createdAt ?? new Date().toISOString()
    )
    .run();
}
