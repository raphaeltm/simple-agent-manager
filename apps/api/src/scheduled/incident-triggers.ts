/** Incident source adapter. Backlog grouping stays in D1; execution policy lives in trigger-admission. */
import {
  DEFAULT_MAX_TRIGGERS_PER_PROJECT,
  DEFAULT_TRIGGER_DEFAULT_MAX_CONCURRENT,
} from '@simple-agent-manager/shared';

import type * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { expectJsonRecord } from '../lib/runtime-validation';
import { ulid } from '../lib/ulid';
import {
  buildIncidentBacklogSummary,
  completeIncidentDispatchLink,
  configuredFeedbackProjectId,
  expireStaleIncidents,
  getIncidentConfig,
  reclaimExpiredIncidentClaims,
  reclaimExpiredIncidentDispatches,
  releaseIncidentDispatch,
  reserveIncidentDispatch,
} from '../services/platform-feedback-incidents';
import {
  admitAndSubmitTriggerExecution,
  type TriggerTaskSubmitter,
} from '../services/trigger-admission';
import { renderTemplate } from '../services/trigger-template';

export interface IncidentTriggerSweepStats {
  enabled: boolean;
  checked: number;
  fired: number;
  skipped: number;
  failed: number;
  pendingIncidents: number;
  requeuedDispatches: number;
  rejectedDispatches: number;
  requeuedClaims: number;
  expiredIncidents: number;
  autoTriggerCreated: number;
}

interface IncidentTriggerSweepDeps {
  now?: () => number;
  submitter?: TriggerTaskSubmitter;
}

interface ProjectRow {
  id: string;
  name: string;
  user_id: string;
}

function positive(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

async function loadIncidentTriggers(
  env: Env,
  projectId: string,
  triggerLimit: number
): Promise<schema.TriggerRow[]> {
  const query = await env.DATABASE.prepare(
    `SELECT id, project_id AS projectId, user_id AS userId, name, description, status,
      source_type AS sourceType, cron_expression AS cronExpression, cron_timezone AS cronTimezone,
      skip_if_running AS skipIfRunning, prompt_template AS promptTemplate,
      agent_profile_id AS agentProfileId, skill_id AS skillId, task_mode AS taskMode,
      vm_size_override AS vmSizeOverride, max_concurrent AS maxConcurrent,
      last_triggered_at AS lastTriggeredAt, trigger_count AS triggerCount,
      next_execution_sequence AS nextExecutionSequence, next_fire_at AS nextFireAt,
      credential_blocked_reason AS credentialBlockedReason,
      credential_blocked_at AS credentialBlockedAt,
      credential_blocked_by AS credentialBlockedBy,
      created_at AS createdAt, updated_at AS updatedAt
     FROM triggers
     WHERE project_id = ? AND source_type = 'incident' AND status = 'active'
     ORDER BY created_at ASC
     LIMIT ?`
  )
    .bind(projectId, triggerLimit)
    .all<schema.TriggerRow>();
  return query.results ?? [];
}

async function hasPendingIncidents(env: Env): Promise<boolean> {
  const row = await env.DATABASE.prepare(
    `SELECT signature FROM platform_feedback_triages
     WHERE queue_state = 'pending' AND rejected_at IS NULL
     ORDER BY queued_at ASC LIMIT 1`
  ).first<{ signature: string }>();
  return Boolean(row);
}

async function hasAnyIncidentTrigger(env: Env, projectId: string): Promise<boolean> {
  const row = await env.DATABASE.prepare(
    `SELECT id FROM triggers
     WHERE project_id = ? AND source_type = 'incident'
     ORDER BY created_at ASC LIMIT 1`
  )
    .bind(projectId)
    .first<{ id: string }>();
  return Boolean(row);
}

async function ensureDefaultIncidentTrigger(
  env: Env,
  project: ProjectRow,
  config: ReturnType<typeof getIncidentConfig>
): Promise<boolean> {
  if (!config.autoTriggerEnabled) return false;
  if (!(await hasPendingIncidents(env))) return false;
  if (await hasAnyIncidentTrigger(env, project.id)) return false;

  const maxTriggers = positive(env.MAX_TRIGGERS_PER_PROJECT, DEFAULT_MAX_TRIGGERS_PER_PROJECT);
  const triggerCount = await env.DATABASE.prepare(
    'SELECT COUNT(*) AS count FROM triggers WHERE project_id = ?'
  )
    .bind(project.id)
    .first<{ count: number }>();
  if ((triggerCount?.count ?? 0) >= maxTriggers) {
    log.warn('incident_trigger_sweep.default_trigger_skipped', {
      projectId: project.id,
      reason: 'max-triggers-reached',
      maxTriggers,
    });
    return false;
  }

  const now = new Date().toISOString();
  const triggerId = ulid();
  const inserted = await env.DATABASE.prepare(
    `INSERT OR IGNORE INTO triggers (
      id, project_id, user_id, name, description, status, source_type,
      cron_expression, cron_timezone, skip_if_running, prompt_template,
      agent_profile_id, skill_id, task_mode, vm_size_override, max_concurrent,
      next_execution_sequence, next_fire_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, NULL, 'active', 'incident', NULL, NULL, 1, ?, NULL, NULL,
      'task', NULL, ?, 1, NULL, ?, ?)`
  )
    .bind(
      triggerId,
      project.id,
      project.user_id,
      config.triggerName,
      config.triggerTemplate,
      DEFAULT_TRIGGER_DEFAULT_MAX_CONCURRENT,
      now,
      now
    )
    .run();
  if ((inserted.meta.changes ?? 0) !== 1) {
    log.warn('incident_trigger_sweep.default_trigger_skipped', {
      projectId: project.id,
      reason: 'insert-conflict',
    });
    return false;
  }
  log.info('incident_trigger_sweep.default_trigger_created', {
    triggerId,
    projectId: project.id,
  });
  return true;
}

function buildIncidentContext(input: {
  trigger: schema.TriggerRow;
  project: ProjectRow;
  executionId: string;
  sequenceNumber: number;
  summary: Awaited<ReturnType<typeof buildIncidentBacklogSummary>>;
}): Record<string, unknown> {
  return {
    trigger: {
      id: input.trigger.id,
      name: input.trigger.name,
      description: input.trigger.description ?? '',
      fireCount: String(input.trigger.triggerCount + 1),
    },
    project: {
      id: input.project.id,
      name: input.project.name,
    },
    execution: {
      id: input.executionId,
      sequenceNumber: String(input.sequenceNumber),
    },
    incident: {
      pendingCount: input.summary.pendingCount,
      totalOccurrenceCount: input.summary.totalOccurrenceCount,
      backlogSummary: input.summary.rendered,
      incidents: input.summary.incidents.map((incident) => ({
        id: incident.id,
        source: incident.source,
        summary: incident.summary,
        severity: incident.severity,
        occurrenceCount: incident.occurrenceCount,
        firstSeenAt: new Date(incident.firstSeenAt).toISOString(),
        lastSeenAt: new Date(incident.lastSeenAt).toISOString(),
        dispatchAttempts: incident.dispatchAttempts,
      })),
      tools: ['list_incident_queue', 'get_incident', 'claim_incident', 'resolve_incident'],
    },
  };
}

export async function runIncidentTriggerSweep(
  env: Env,
  deps: IncidentTriggerSweepDeps = {}
): Promise<IncidentTriggerSweepStats> {
  const projectId = await configuredFeedbackProjectId(env);
  const base: IncidentTriggerSweepStats = {
    enabled: Boolean(projectId),
    checked: 0,
    fired: 0,
    skipped: 0,
    failed: 0,
    pendingIncidents: 0,
    requeuedDispatches: 0,
    rejectedDispatches: 0,
    requeuedClaims: 0,
    expiredIncidents: 0,
    autoTriggerCreated: 0,
  };
  if (!projectId) return base;

  const project = await env.DATABASE.prepare('SELECT id, name, user_id FROM projects WHERE id = ?')
    .bind(projectId)
    .first<ProjectRow>();
  if (!project)
    throw new Error('Configured feedback project does not reference an existing project');

  const now = deps.now?.() ?? Date.now();
  const config = getIncidentConfig(env);
  base.expiredIncidents = await expireStaleIncidents(env, now, config);
  const reclaim = await reclaimExpiredIncidentDispatches(env, now, config);
  base.requeuedDispatches = reclaim.requeued;
  base.rejectedDispatches = reclaim.rejected;
  base.requeuedClaims = await reclaimExpiredIncidentClaims(env, now);
  base.autoTriggerCreated = (await ensureDefaultIncidentTrigger(env, project, config)) ? 1 : 0;

  const triggers = await loadIncidentTriggers(env, projectId, config.triggerLimit);
  base.checked = triggers.length;
  if (triggers.length === 0) return base;

  const submitter = deps.submitter;

  for (const trigger of triggers) {
    const summary = await buildIncidentBacklogSummary(env, config.summaryLimit, now);
    base.pendingIncidents = Math.max(base.pendingIncidents, summary.pendingCount);
    if (summary.pendingCount === 0) break;

    const signatures = summary.incidents.map((incident) => incident.id);
    let reservedExecutionId: string | null = null;
    const admission = await admitAndSubmitTriggerExecution(
      env,
      {
        trigger,
        eventType: 'incident_backlog',
        triggeredBy: 'incident',
        renderPrompt: (executionId, sequenceNumber) => {
          const context = buildIncidentContext({
            trigger,
            project,
            executionId,
            sequenceNumber,
            summary,
          });
          return renderTemplate(
            trigger.promptTemplate,
            expectJsonRecord(context, 'incident.trigger_context')
          ).rendered;
        },
        beforeSubmit: async (executionId) => {
          reservedExecutionId = executionId;
          const reserved = await reserveIncidentDispatch(
            env,
            signatures,
            trigger.id,
            executionId,
            now,
            config
          );
          if (reserved.reserved === 0) {
            throw new Error('No pending incidents remained for incident trigger dispatch');
          }
        },
      },
      submitter
    );

    if (admission.outcome === 'submitted' || admission.outcome === 'pending') {
      await completeIncidentDispatchLink(env, admission.executionId, admission.taskId);
      base.fired += 1;
      log.info('incident_trigger_sweep.fired', {
        triggerId: trigger.id,
        executionId: admission.executionId,
        taskId: admission.taskId,
        projectId,
        pendingIncidents: summary.pendingCount,
        submissionPending: admission.outcome === 'pending',
      });
      break;
    }

    if (admission.outcome === 'failed') {
      if (reservedExecutionId) await releaseIncidentDispatch(env, reservedExecutionId);
      base.failed += 1;
      continue;
    }

    if (admission.outcome === 'inactive') {
      log.warn('incident_trigger_sweep.inactive', {
        triggerId: trigger.id,
        projectId,
        reason: admission.reason,
        pendingIncidents: summary.pendingCount,
      });
      base.skipped += 1;
      continue;
    }

    if (admission.outcome === 'skipped') {
      log.warn('incident_trigger_sweep.skipped', {
        triggerId: trigger.id,
        executionId: admission.executionId,
        projectId,
        reason: admission.reason,
        pendingIncidents: summary.pendingCount,
      });
      base.skipped += 1;
      continue;
    }

    base.skipped += 1;
  }

  return base;
}
