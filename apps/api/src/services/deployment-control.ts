import { and, desc, eq, gt, inArray } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import { log } from '../lib/logger';
import type { McpTokenData } from './mcp-token';

const MAX_OBSERVED_ERROR_MESSAGE_LENGTH = 4096;
const MAX_OBSERVED_JSON_LENGTH = 64_000;

const TERMINAL_FAILURE_STATUSES = new Set(['failed', 'failed-initial', 'reverted']);
const APPLY_SUCCESS_STATUSES = new Set(['applied', 'reverted', 'failed']);

export interface DeploymentHeartbeatState {
  appliedSeq?: number;
  status?: string;
  errorMessage?: string;
  services?: unknown;
  deployStatus?: unknown;
  diskTelemetry?: unknown;
}

export interface ObservedDeploymentState {
  appliedSeq: number | null;
  status: string | null;
  errorMessage: string | null;
  services: unknown | null;
  deployStatus: unknown | null;
  diskTelemetry: unknown | null;
  observedAt: string | null;
}

export interface DeploymentAgentPolicy {
  agentDeployEnabled: boolean;
  agentDeployEnabledBy: string | null;
  agentDeployEnabledAt: string | null;
  agentDeployDisabledAt: string | null;
  allowedDeployProfileIds: string[];
}

export function parseJsonField(value: string | null | undefined): unknown | null {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function truncateString(value: string, maxLength: number): string {
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

function safeJsonStringify(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  try {
    const encoded = JSON.stringify(value);
    if (!encoded) return null;
    return encoded.length > MAX_OBSERVED_JSON_LENGTH
      ? JSON.stringify({ truncated: true, originalLength: encoded.length })
      : encoded;
  } catch {
    return JSON.stringify({ unsupported: true });
  }
}

function normalizeAppliedSeq(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return null;
  }
  return Math.floor(value);
}

function normalizeStatus(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim().toLowerCase();
  return trimmed ? truncateString(trimmed, 64) : null;
}

export function buildObservedDeploymentUpdate(
  deployment: DeploymentHeartbeatState,
  observedAt: string,
): Partial<schema.NewDeploymentEnvironmentRow> {
  const appliedSeq = normalizeAppliedSeq(deployment.appliedSeq);
  const status = normalizeStatus(deployment.status);
  const errorMessage = typeof deployment.errorMessage === 'string'
    ? truncateString(deployment.errorMessage, MAX_OBSERVED_ERROR_MESSAGE_LENGTH)
    : null;

  return {
    observedAppliedSeq: appliedSeq,
    observedStatus: status,
    observedErrorMessage: errorMessage,
    observedServicesJson: safeJsonStringify(deployment.services),
    observedDeployStatusJson: safeJsonStringify(deployment.deployStatus),
    observedDiskTelemetryJson: safeJsonStringify(deployment.diskTelemetry),
    observedAt,
    updatedAt: observedAt,
  };
}

export function toObservedDeploymentState(
  row: Pick<
    schema.DeploymentEnvironmentRow,
    | 'observedAppliedSeq'
    | 'observedStatus'
    | 'observedErrorMessage'
    | 'observedServicesJson'
    | 'observedDeployStatusJson'
    | 'observedDiskTelemetryJson'
    | 'observedAt'
  >,
): ObservedDeploymentState {
  return {
    appliedSeq: row.observedAppliedSeq ?? null,
    status: row.observedStatus ?? null,
    errorMessage: row.observedErrorMessage ?? null,
    services: parseJsonField(row.observedServicesJson),
    deployStatus: parseJsonField(row.observedDeployStatusJson),
    diskTelemetry: parseJsonField(row.observedDiskTelemetryJson),
    observedAt: row.observedAt ?? null,
  };
}

export function parseAllowedDeployProfileIds(value: string | null | undefined): string[] {
  const parsed = parseJsonField(value);
  if (!Array.isArray(parsed)) return [];
  const unique = new Set<string>();
  for (const item of parsed) {
    if (typeof item === 'string' && item.trim()) {
      unique.add(item.trim());
    }
  }
  return [...unique];
}

export function uniqueDeployProfileIds(values: string[] | null | undefined): string[] {
  if (!values) return [];
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

export function toDeploymentAgentPolicy(
  row: Pick<
    schema.DeploymentEnvironmentRow,
    | 'agentDeployEnabled'
    | 'agentDeployEnabledBy'
    | 'agentDeployEnabledAt'
    | 'agentDeployDisabledAt'
    | 'allowedDeployProfileIdsJson'
  >,
): DeploymentAgentPolicy {
  return {
    agentDeployEnabled: Boolean(row.agentDeployEnabled),
    agentDeployEnabledBy: row.agentDeployEnabledBy ?? null,
    agentDeployEnabledAt: row.agentDeployEnabledAt ?? null,
    agentDeployDisabledAt: row.agentDeployDisabledAt ?? null,
    allowedDeployProfileIds: parseAllowedDeployProfileIds(row.allowedDeployProfileIdsJson),
  };
}

export async function reconcileDeploymentReleaseStatuses(
  db: ReturnType<typeof drizzle<typeof schema>>,
  environmentId: string,
  deployment: DeploymentHeartbeatState,
): Promise<void> {
  const appliedSeq = normalizeAppliedSeq(deployment.appliedSeq) ?? 0;
  const status = normalizeStatus(deployment.status);
  if (!status) return;

  const latestRows = await db
    .select({
      id: schema.deploymentReleases.id,
      version: schema.deploymentReleases.version,
      status: schema.deploymentReleases.status,
    })
    .from(schema.deploymentReleases)
    .where(eq(schema.deploymentReleases.environmentId, environmentId))
    .orderBy(desc(schema.deploymentReleases.version))
    .limit(1);

  const latest = latestRows[0];

  if (appliedSeq > 0 && APPLY_SUCCESS_STATUSES.has(status)) {
    await db
      .update(schema.deploymentReleases)
      .set({ status: 'applied' })
      .where(
        and(
          eq(schema.deploymentReleases.environmentId, environmentId),
          eq(schema.deploymentReleases.version, appliedSeq),
        ),
      );
  }

  if (!latest) return;

  if (status === 'applying' && latest.version > appliedSeq) {
    await db
      .update(schema.deploymentReleases)
      .set({ status: 'applying' })
      .where(eq(schema.deploymentReleases.id, latest.id));
    return;
  }

  if (status === 'applied' && latest.version === appliedSeq && latest.status !== 'applied') {
    await db
      .update(schema.deploymentReleases)
      .set({ status: 'applied' })
      .where(eq(schema.deploymentReleases.id, latest.id));
    return;
  }

  if (TERMINAL_FAILURE_STATUSES.has(status) && latest.version > appliedSeq) {
    await db
      .update(schema.deploymentReleases)
      .set({ status: 'failed' })
      .where(
        and(
          eq(schema.deploymentReleases.environmentId, environmentId),
          gt(schema.deploymentReleases.version, appliedSeq),
        ),
      );
  }
}

async function getTaskAgentProfileId(
  db: ReturnType<typeof drizzle<typeof schema>>,
  taskId: string,
): Promise<string | null> {
  if (!taskId) return null;
  const rows = await db
    .select({ agentProfileHint: schema.tasks.agentProfileHint })
    .from(schema.tasks)
    .where(eq(schema.tasks.id, taskId))
    .limit(1);
  return rows[0]?.agentProfileHint ?? null;
}

export async function assertAgentDeploymentAllowed(
  db: ReturnType<typeof drizzle<typeof schema>>,
  projectId: string,
  environmentName: string,
  tokenData: McpTokenData,
): Promise<{ environmentId: string; policy: DeploymentAgentPolicy } | { error: string }> {
  const rows = await db
    .select({
      id: schema.deploymentEnvironments.id,
      agentDeployEnabled: schema.deploymentEnvironments.agentDeployEnabled,
      agentDeployEnabledBy: schema.deploymentEnvironments.agentDeployEnabledBy,
      agentDeployEnabledAt: schema.deploymentEnvironments.agentDeployEnabledAt,
      agentDeployDisabledAt: schema.deploymentEnvironments.agentDeployDisabledAt,
      allowedDeployProfileIdsJson: schema.deploymentEnvironments.allowedDeployProfileIdsJson,
    })
    .from(schema.deploymentEnvironments)
    .where(
      and(
        eq(schema.deploymentEnvironments.projectId, projectId),
        eq(schema.deploymentEnvironments.name, environmentName),
        eq(schema.deploymentEnvironments.status, 'active'),
      ),
    )
    .limit(1);

  const row = rows[0];
  if (!row) {
    return { error: `Deployment environment '${environmentName}' not found or inactive for this project.` };
  }

  const policy = toDeploymentAgentPolicy(row);
  if (!policy.agentDeployEnabled) {
    return {
      error: `Agent deployment is disabled for environment '${environmentName}'. Enable it in the deployment environment policy before agents can use deployment tools.`,
    };
  }

  if (policy.allowedDeployProfileIds.length > 0) {
    const taskProfileId = await getTaskAgentProfileId(db, tokenData.taskId);
    if (!taskProfileId || !policy.allowedDeployProfileIds.includes(taskProfileId)) {
      log.warn('deployment_agent_policy.denied_profile', {
        projectId,
        environmentName,
        taskId: tokenData.taskId || null,
        taskProfileId,
      });
      return {
        error: `This agent profile is not allowed to deploy to environment '${environmentName}'.`,
      };
    }
  }

  return { environmentId: row.id, policy };
}

export function encodeAllowedDeployProfileIds(profileIds: string[] | null | undefined): string | null {
  const unique = uniqueDeployProfileIds(profileIds);
  if (unique.length === 0) {
    return null;
  }
  return JSON.stringify(unique);
}

export async function validateAllowedDeployProfiles(
  db: ReturnType<typeof drizzle<typeof schema>>,
  projectId: string,
  allowedProfileIds: string[],
): Promise<void> {
  if (allowedProfileIds.length === 0) return;

  const rows = await db
    .select({ id: schema.agentProfiles.id })
    .from(schema.agentProfiles)
    .where(
      and(
        eq(schema.agentProfiles.projectId, projectId),
        inArray(schema.agentProfiles.id, allowedProfileIds),
      ),
    );

  const found = new Set(rows.map((row) => row.id));
  const missing = allowedProfileIds.filter((id) => !found.has(id));
  if (missing.length > 0) {
    throw new Error(`Agent profile(s) not found in this project: ${missing.join(', ')}`);
  }
}
