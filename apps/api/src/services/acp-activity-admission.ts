import {
  type AcpSession,
  DEFAULT_ACP_ACTIVITY_ADMISSION_ENABLED,
  DEFAULT_ACP_ACTIVITY_BINDING_CACHE_MAX_ENTRIES,
  DEFAULT_ACP_ACTIVITY_BINDING_CACHE_TTL_MS,
  DEFAULT_ACP_ACTIVITY_COALESCE_MAX_PENDING,
  DEFAULT_ACP_ACTIVITY_COALESCE_TTL_MS,
  DEFAULT_ACP_ACTIVITY_COALESCE_WINDOW_MS,
} from '@simple-agent-manager/shared';

import type { Env } from '../env';
import { log } from '../lib/logger';
import { parsePositiveInt } from '../lib/route-helpers';
import { recordAcpActivityCallbackMetric } from './telemetry';

export type AcpActivityName = 'prompting' | 'idle' | 'recovering' | 'error';
export type AcpRuntimeWorkState = 'inactive' | 'active' | 'settling';

export interface AcpActivityCallbackReport {
  activity: AcpActivityName;
  nodeId: string;
  promptStartedAt?: number;
  agentType?: string;
  restartCount?: number;
  statusError?: string | null;
  runtimeWorkState?: AcpRuntimeWorkState;
  runtimeWorkCount?: number;
  runtimeWorkSource?: string;
  runtimeWorkProgressAt?: number;
}

export interface AcpActivityBinding {
  sessionId: string;
  chatSessionId: string;
  workspaceId: string | null;
  nodeId: string;
  acpSdkSessionId: string | null;
  status: AcpSession['status'];
  agentType: string | null;
}

export interface AcpActivityAdmissionEnv {
  ACP_ACTIVITY_ADMISSION_ENABLED?: string;
  ACP_ACTIVITY_COALESCE_WINDOW_MS?: string;
  ACP_ACTIVITY_COALESCE_TTL_MS?: string;
  ACP_ACTIVITY_COALESCE_MAX_PENDING?: string;
  ACP_ACTIVITY_BINDING_CACHE_TTL_MS?: string;
  ACP_ACTIVITY_BINDING_CACHE_MAX_ENTRIES?: string;
}

export interface AcpActivityAdmissionConfig {
  enabled: boolean;
  coalesceWindowMs: number;
  coalesceTtlMs: number;
  maxPending: number;
  bindingCacheTtlMs: number;
  bindingCacheMaxEntries: number;
}

type AcpActivityAdmitReason =
  | 'disabled'
  | 'critical_transition'
  | 'first_report'
  | 'activity_transition'
  | 'new_prompt_epoch'
  | 'runtime_work_transition'
  | 'coalesce_window_elapsed';

export type AcpActivityAdmissionDecision =
  | {
      action: 'admit';
      reason: AcpActivityAdmitReason;
      pendingCount: number;
    }
  | {
      action: 'coalesce';
      reason: 'redundant_intermediate' | 'project_data_transient';
      pendingCount: number;
      coalescedCount: number;
    };

export type AcpActivityFlushResult =
  | { action: 'flushed' }
  | { action: 'retry'; reason: string }
  | { action: 'rejected'; reason: string };

export interface AcpActivityPendingSnapshot {
  key: string;
  projectId: string;
  sessionId: string;
  binding: AcpActivityBinding;
  report: AcpActivityCallbackReport;
  observedAt: number;
  firstCoalescedAt: number;
  updatedAt: number;
  expiresAt: number;
  coalescedCount: number;
  reason: 'redundant_intermediate' | 'project_data_transient';
  version: number;
}

export type AcpActivityFlushHandler = (
  snapshot: AcpActivityPendingSnapshot
) => Promise<AcpActivityFlushResult>;

export type WaitUntilFn = (promise: Promise<unknown>) => void;

interface RecentActivityState {
  binding: AcpActivityBinding;
  report: AcpActivityCallbackReport;
  admittedAt: number;
  expiresAt: number;
}

interface PendingActivityState extends AcpActivityPendingSnapshot {
  flushScheduled: boolean;
}

interface BindingCacheEntry {
  binding: AcpActivityBinding;
  expiresAt: number;
}

const recentActivityByKey = new Map<string, RecentActivityState>();
const pendingActivityByKey = new Map<string, PendingActivityState>();
const bindingCacheByKey = new Map<string, BindingCacheEntry>();
let pendingVersionCounter = 0;

function activityKey(projectId: string, sessionId: string): string {
  return `${projectId}\u0000${sessionId}`;
}

function flagEnabled(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === '') return fallback;
  return !['0', 'false', 'no', 'off'].includes(normalized);
}

export function getAcpActivityAdmissionConfig(
  env: AcpActivityAdmissionEnv
): AcpActivityAdmissionConfig {
  const coalesceWindowMs = parsePositiveInt(
    env.ACP_ACTIVITY_COALESCE_WINDOW_MS,
    DEFAULT_ACP_ACTIVITY_COALESCE_WINDOW_MS
  );
  const rawTtlMs = parsePositiveInt(
    env.ACP_ACTIVITY_COALESCE_TTL_MS,
    DEFAULT_ACP_ACTIVITY_COALESCE_TTL_MS
  );

  return {
    enabled: flagEnabled(
      env.ACP_ACTIVITY_ADMISSION_ENABLED,
      DEFAULT_ACP_ACTIVITY_ADMISSION_ENABLED
    ),
    coalesceWindowMs,
    coalesceTtlMs: Math.max(rawTtlMs, coalesceWindowMs),
    maxPending: parsePositiveInt(
      env.ACP_ACTIVITY_COALESCE_MAX_PENDING,
      DEFAULT_ACP_ACTIVITY_COALESCE_MAX_PENDING
    ),
    bindingCacheTtlMs: parsePositiveInt(
      env.ACP_ACTIVITY_BINDING_CACHE_TTL_MS,
      DEFAULT_ACP_ACTIVITY_BINDING_CACHE_TTL_MS
    ),
    bindingCacheMaxEntries: parsePositiveInt(
      env.ACP_ACTIVITY_BINDING_CACHE_MAX_ENTRIES,
      DEFAULT_ACP_ACTIVITY_BINDING_CACHE_MAX_ENTRIES
    ),
  };
}

export function isIntermediateAcpActivityReport(report: AcpActivityCallbackReport): boolean {
  if (report.activity === 'prompting' || report.activity === 'recovering') return true;
  return (
    report.activity === 'idle' &&
    (report.runtimeWorkState === 'active' || report.runtimeWorkState === 'settling')
  );
}

export function buildAcpActivityBinding(session: AcpSession): AcpActivityBinding | null {
  if (!session.nodeId) return null;
  return {
    sessionId: session.id,
    chatSessionId: session.chatSessionId,
    workspaceId: session.workspaceId,
    nodeId: session.nodeId,
    acpSdkSessionId: session.acpSdkSessionId,
    status: session.status,
    agentType: session.agentType,
  };
}

export function getCachedAcpActivityBinding(
  config: AcpActivityAdmissionConfig,
  projectId: string,
  sessionId: string,
  now = Date.now()
): AcpActivityBinding | null {
  evictExpiredBindingCache(now);
  if (!config.enabled) return null;

  const entry = bindingCacheByKey.get(activityKey(projectId, sessionId));
  if (!entry) return null;
  if (entry.expiresAt <= now) {
    bindingCacheByKey.delete(activityKey(projectId, sessionId));
    return null;
  }
  return entry.binding;
}

export function cacheAcpActivityBinding(
  config: AcpActivityAdmissionConfig,
  projectId: string,
  binding: AcpActivityBinding,
  now = Date.now()
): void {
  if (!config.enabled) return;
  evictExpiredBindingCache(now);

  const key = activityKey(projectId, binding.sessionId);
  bindingCacheByKey.set(key, {
    binding,
    expiresAt: now + config.bindingCacheTtlMs,
  });
  evictOldestBindings(config.bindingCacheMaxEntries);
}

export function admitOrCoalesceAcpActivityCallback(input: {
  env: Env;
  config: AcpActivityAdmissionConfig;
  projectId: string;
  sessionId: string;
  binding: AcpActivityBinding;
  report: AcpActivityCallbackReport;
  observedAt?: number;
  waitUntil: WaitUntilFn;
  flush: AcpActivityFlushHandler;
  now?: number;
}): AcpActivityAdmissionDecision {
  const now = input.now ?? Date.now();
  const key = activityKey(input.projectId, input.sessionId);
  evictExpiredRecentActivity(now);
  evictExpiredPendingActivity(input.env, now);

  if (!input.config.enabled) {
    clearPendingAcpActivity(input.projectId, input.sessionId);
    return { action: 'admit', reason: 'disabled', pendingCount: pendingActivityByKey.size };
  }

  if (!isIntermediateAcpActivityReport(input.report)) {
    clearPendingAcpActivity(input.projectId, input.sessionId);
    return {
      action: 'admit',
      reason: 'critical_transition',
      pendingCount: pendingActivityByKey.size,
    };
  }

  const recent = recentActivityByKey.get(key);
  const pending = pendingActivityByKey.get(key);
  const latestReport = pending?.report ?? recent?.report ?? null;

  const admitReason = shouldAdmitIntermediate({
    report: input.report,
    latestReport,
    recent,
    windowMs: input.config.coalesceWindowMs,
    now,
  });

  if (admitReason) {
    clearPendingAcpActivity(input.projectId, input.sessionId);
    return {
      action: 'admit',
      reason: admitReason,
      pendingCount: pendingActivityByKey.size,
    };
  }

  return coalescePendingActivity({
    ...input,
    key,
    now,
    reason: 'redundant_intermediate',
  });
}

export function coalesceAcpActivityAfterProjectDataTransient(input: {
  env: Env;
  config: AcpActivityAdmissionConfig;
  projectId: string;
  sessionId: string;
  binding: AcpActivityBinding;
  report: AcpActivityCallbackReport;
  observedAt?: number;
  waitUntil: WaitUntilFn;
  flush: AcpActivityFlushHandler;
  now?: number;
}): AcpActivityAdmissionDecision {
  const now = input.now ?? Date.now();
  evictExpiredRecentActivity(now);
  evictExpiredPendingActivity(input.env, now);

  return coalescePendingActivity({
    ...input,
    key: activityKey(input.projectId, input.sessionId),
    now,
    reason: 'project_data_transient',
  });
}

export function recordAcpActivityAdmissionSuccess(input: {
  env: Env;
  projectId: string;
  sessionId: string;
  binding: AcpActivityBinding;
  report: AcpActivityCallbackReport;
  reason: string;
  source?: 'callback' | 'coalesced_flush';
  coalescedCount?: number;
  now?: number;
}): void {
  const now = input.now ?? Date.now();
  const config = getAcpActivityAdmissionConfig(input.env);
  if (config.enabled) {
    evictExpiredRecentActivity(now);
    recentActivityByKey.set(activityKey(input.projectId, input.sessionId), {
      binding: input.binding,
      report: withoutSensitiveActivityFields(input.report),
      admittedAt: now,
      expiresAt: now + config.coalesceTtlMs,
    });
    // Recent state is per ACP session, so reuse the configurable session-binding
    // cache cap instead of introducing a second equivalent session-count knob.
    evictOldestRecentActivity(config.bindingCacheMaxEntries);
  }
  recordAcpActivityCallbackMetric(
    {
      metric: 'acp_activity_callback',
      outcome: 'admitted',
      projectId: input.projectId,
      sessionId: input.sessionId,
      nodeId: input.binding.nodeId,
      workspaceId: input.binding.workspaceId,
      activity: input.report.activity,
      reason: input.reason,
      source: input.source ?? 'callback',
      coalescedCount: input.coalescedCount,
      pendingCount: pendingActivityByKey.size,
    },
    input.env
  );
}

export function clearPendingAcpActivity(projectId: string, sessionId: string): void {
  pendingActivityByKey.delete(activityKey(projectId, sessionId));
}

export function isPendingAcpActivitySnapshotCurrent(
  snapshot: AcpActivityPendingSnapshot
): boolean {
  return pendingActivityByKey.get(snapshot.key)?.version === snapshot.version;
}

export function resetAcpActivityAdmissionForTests(): void {
  recentActivityByKey.clear();
  pendingActivityByKey.clear();
  bindingCacheByKey.clear();
  pendingVersionCounter = 0;
}

export function getAcpActivityAdmissionSnapshotForTests(): {
  recent: number;
  pending: number;
  cachedBindings: number;
} {
  return {
    recent: recentActivityByKey.size,
    pending: pendingActivityByKey.size,
    cachedBindings: bindingCacheByKey.size,
  };
}

function shouldAdmitIntermediate(input: {
  report: AcpActivityCallbackReport;
  latestReport: AcpActivityCallbackReport | null;
  recent: RecentActivityState | undefined;
  windowMs: number;
  now: number;
}): AcpActivityAdmitReason | null {
  if (!input.latestReport) return 'first_report';
  if (input.report.activity !== input.latestReport.activity) return 'activity_transition';

  const reportPromptStartedAt = normalizedNumber(input.report.promptStartedAt);
  const latestPromptStartedAt = normalizedNumber(input.latestReport.promptStartedAt);
  if (
    reportPromptStartedAt !== null &&
    (latestPromptStartedAt === null || reportPromptStartedAt > latestPromptStartedAt)
  ) {
    return 'new_prompt_epoch';
  }

  const reportRuntimeWorkState = input.report.runtimeWorkState ?? null;
  const latestRuntimeWorkState = input.latestReport.runtimeWorkState ?? null;
  if (reportRuntimeWorkState !== latestRuntimeWorkState) return 'runtime_work_transition';

  if (input.recent && input.now - input.recent.admittedAt >= input.windowMs) {
    return 'coalesce_window_elapsed';
  }

  return null;
}

function coalescePendingActivity(input: {
  env: Env;
  config: AcpActivityAdmissionConfig;
  projectId: string;
  sessionId: string;
  binding: AcpActivityBinding;
  report: AcpActivityCallbackReport;
  observedAt?: number;
  waitUntil: WaitUntilFn;
  flush: AcpActivityFlushHandler;
  key: string;
  now: number;
  reason: 'redundant_intermediate' | 'project_data_transient';
}): AcpActivityAdmissionDecision {
  const existing = pendingActivityByKey.get(input.key);
  if (!existing) {
    ensurePendingCapacity(input.env, input.config, input.now);
  }

  const pending: PendingActivityState = {
    key: input.key,
    projectId: input.projectId,
    sessionId: input.sessionId,
    binding: input.binding,
    report: withoutSensitiveActivityFields(input.report),
    observedAt: input.observedAt ?? input.now,
    firstCoalescedAt: existing?.firstCoalescedAt ?? input.now,
    updatedAt: input.now,
    expiresAt: existing?.expiresAt ?? input.now + input.config.coalesceTtlMs,
    coalescedCount: (existing?.coalescedCount ?? 0) + 1,
    reason: input.reason,
    version: ++pendingVersionCounter,
    flushScheduled: existing?.flushScheduled ?? false,
  };
  pendingActivityByKey.set(input.key, pending);

  if (!pending.flushScheduled) {
    pending.flushScheduled = true;
    pendingActivityByKey.set(input.key, pending);
    schedulePendingFlush(input.env, input.config, input.key, input.waitUntil, input.flush);
  }

  recordAcpActivityCallbackMetric(
    {
      metric: 'acp_activity_callback',
      outcome: 'coalesced',
      projectId: input.projectId,
      sessionId: input.sessionId,
      nodeId: input.binding.nodeId,
      workspaceId: input.binding.workspaceId,
      activity: input.report.activity,
      reason: input.reason,
      source: 'callback',
      coalescedCount: pending.coalescedCount,
      pendingCount: pendingActivityByKey.size,
    },
    input.env
  );

  return {
    action: 'coalesce',
    reason: input.reason,
    pendingCount: pendingActivityByKey.size,
    coalescedCount: pending.coalescedCount,
  };
}

function schedulePendingFlush(
  env: Env,
  config: AcpActivityAdmissionConfig,
  key: string,
  waitUntil: WaitUntilFn,
  flush: AcpActivityFlushHandler
): void {
  const promise = delay(config.coalesceWindowMs)
    .then(() => flushPendingActivity(env, config, key, waitUntil, flush))
    .catch((err) => {
      log.warn('acp_activity.coalesced_flush_failed', {
        key,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  waitUntil(promise);
}

async function flushPendingActivity(
  env: Env,
  config: AcpActivityAdmissionConfig,
  key: string,
  waitUntil: WaitUntilFn,
  flush: AcpActivityFlushHandler
): Promise<void> {
  const pending = pendingActivityByKey.get(key);
  if (!pending) return;

  const now = Date.now();
  if (pending.expiresAt <= now) {
    pendingActivityByKey.delete(key);
    recordRejectedPending(env, pending, 'pending_ttl_expired');
    return;
  }

  pending.flushScheduled = false;
  pendingActivityByKey.set(key, pending);
  const snapshot: AcpActivityPendingSnapshot = {
    key: pending.key,
    projectId: pending.projectId,
    sessionId: pending.sessionId,
    binding: pending.binding,
    report: pending.report,
    observedAt: pending.observedAt,
    firstCoalescedAt: pending.firstCoalescedAt,
    updatedAt: pending.updatedAt,
    expiresAt: pending.expiresAt,
    coalescedCount: pending.coalescedCount,
    reason: pending.reason,
    version: pending.version,
  };

  const startedAt = Date.now();
  const result = await flush(snapshot);
  if (result.action === 'flushed') {
    if (pendingActivityByKey.get(key)?.version === snapshot.version) {
      pendingActivityByKey.delete(key);
    }
    recordAcpActivityAdmissionSuccess({
      env,
      projectId: snapshot.projectId,
      sessionId: snapshot.sessionId,
      binding: snapshot.binding,
      report: snapshot.report,
      reason: 'coalesced_flush',
      source: 'coalesced_flush',
      coalescedCount: snapshot.coalescedCount,
    });
    return;
  }

  if (result.action === 'rejected') {
    if (pendingActivityByKey.get(key)?.version === snapshot.version) {
      pendingActivityByKey.delete(key);
    }
    recordRejectedPending(env, snapshot, result.reason, Date.now() - startedAt);
    return;
  }

  const latest = pendingActivityByKey.get(key);
  if (!latest || latest.expiresAt <= Date.now()) {
    if (latest) pendingActivityByKey.delete(key);
    recordRejectedPending(
      env,
      latest ?? snapshot,
      'pending_retry_ttl_expired',
      Date.now() - startedAt
    );
    return;
  }

  if (!latest.flushScheduled) {
    latest.flushScheduled = true;
    pendingActivityByKey.set(key, latest);
    schedulePendingFlush(env, config, key, waitUntil, flush);
  }
}

function ensurePendingCapacity(env: Env, config: AcpActivityAdmissionConfig, now: number): void {
  evictExpiredPendingActivity(env, now);
  if (pendingActivityByKey.size < config.maxPending) return;

  let oldestKey: string | null = null;
  let oldestUpdatedAt = Number.POSITIVE_INFINITY;
  for (const [key, pending] of pendingActivityByKey.entries()) {
    if (pending.updatedAt < oldestUpdatedAt) {
      oldestUpdatedAt = pending.updatedAt;
      oldestKey = key;
    }
  }

  if (!oldestKey) return;
  const evicted = pendingActivityByKey.get(oldestKey);
  pendingActivityByKey.delete(oldestKey);
  if (evicted) {
    recordRejectedPending(env, evicted, 'pending_capacity_evicted');
  }
}

function evictExpiredPendingActivity(env: Env, now: number): void {
  for (const [key, pending] of pendingActivityByKey.entries()) {
    if (pending.expiresAt > now) continue;
    pendingActivityByKey.delete(key);
    recordRejectedPending(env, pending, 'pending_ttl_expired');
  }
}

function evictExpiredRecentActivity(now: number): void {
  for (const [key, state] of recentActivityByKey.entries()) {
    if (state.expiresAt <= now) {
      recentActivityByKey.delete(key);
    }
  }
}

function evictOldestRecentActivity(maxEntries: number): void {
  while (recentActivityByKey.size > maxEntries) {
    let oldestKey: string | null = null;
    let oldestAdmittedAt = Number.POSITIVE_INFINITY;
    for (const [key, state] of recentActivityByKey.entries()) {
      if (state.admittedAt < oldestAdmittedAt) {
        oldestAdmittedAt = state.admittedAt;
        oldestKey = key;
      }
    }
    if (!oldestKey) return;
    recentActivityByKey.delete(oldestKey);
  }
}

function evictExpiredBindingCache(now: number): void {
  for (const [key, entry] of bindingCacheByKey.entries()) {
    if (entry.expiresAt <= now) {
      bindingCacheByKey.delete(key);
    }
  }
}

function evictOldestBindings(maxEntries: number): void {
  while (bindingCacheByKey.size > maxEntries) {
    let oldestKey: string | null = null;
    let oldestExpiresAt = Number.POSITIVE_INFINITY;
    for (const [key, entry] of bindingCacheByKey.entries()) {
      if (entry.expiresAt < oldestExpiresAt) {
        oldestExpiresAt = entry.expiresAt;
        oldestKey = key;
      }
    }
    if (!oldestKey) return;
    bindingCacheByKey.delete(oldestKey);
  }
}

function recordRejectedPending(
  env: Env,
  pending: AcpActivityPendingSnapshot,
  reason: string,
  durationMs?: number
): void {
  recordAcpActivityCallbackMetric(
    {
      metric: 'acp_activity_callback',
      outcome: 'rejected',
      projectId: pending.projectId,
      sessionId: pending.sessionId,
      nodeId: pending.binding.nodeId,
      workspaceId: pending.binding.workspaceId,
      activity: pending.report.activity,
      reason,
      source: 'admission_control',
      coalescedCount: pending.coalescedCount,
      pendingCount: pendingActivityByKey.size,
      durationMs,
    },
    env
  );
}

function normalizedNumber(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function withoutSensitiveActivityFields(
  report: AcpActivityCallbackReport
): AcpActivityCallbackReport {
  return {
    activity: report.activity,
    nodeId: report.nodeId,
    promptStartedAt: report.promptStartedAt,
    agentType: report.agentType,
    restartCount: report.restartCount,
    statusError: report.statusError,
    runtimeWorkState: report.runtimeWorkState,
    runtimeWorkCount: report.runtimeWorkCount,
    runtimeWorkSource: report.runtimeWorkSource,
    runtimeWorkProgressAt: report.runtimeWorkProgressAt,
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
