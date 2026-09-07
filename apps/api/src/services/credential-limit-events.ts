import type {
  AdmitProjectEventInput,
  ProjectEventJsonValue,
  ProjectEventMetadata,
  ProjectEventSeverity,
} from '@simple-agent-manager/shared';
import {
  DEFAULT_CREDENTIAL_LIMIT_CRITICAL_PERCENT,
  DEFAULT_CREDENTIAL_LIMIT_WARNING_PERCENT,
  DEFAULT_PROJECT_EVENT_LIMITS,
} from '@simple-agent-manager/shared';

import type { Env } from '../env';
import { log } from '../lib/logger';
import * as projectDataService from './project-data';

export const CREDENTIAL_LIMIT_EVENT_SOURCE = 'sam.credential_limit';

export const CREDENTIAL_LIMIT_EVENT_TYPES = {
  warning: 'credential.limit.warning',
  critical: 'credential.limit.critical',
  rejected: 'credential.limit.rejected',
  reset: 'credential.limit.reset',
} as const;

export const CREDENTIAL_LIMIT_PROVIDER_HEADERS = [
  'anthropic-ratelimit-requests-limit',
  'anthropic-ratelimit-requests-remaining',
  'anthropic-ratelimit-requests-reset',
  'anthropic-ratelimit-tokens-limit',
  'anthropic-ratelimit-tokens-remaining',
  'anthropic-ratelimit-tokens-reset',
  'anthropic-ratelimit-input-tokens-limit',
  'anthropic-ratelimit-input-tokens-remaining',
  'anthropic-ratelimit-input-tokens-reset',
  'anthropic-ratelimit-output-tokens-limit',
  'anthropic-ratelimit-output-tokens-remaining',
  'anthropic-ratelimit-output-tokens-reset',
  'anthropic-ratelimit-priority-input-tokens-limit',
  'anthropic-ratelimit-priority-input-tokens-remaining',
  'anthropic-ratelimit-priority-input-tokens-reset',
  'anthropic-ratelimit-priority-output-tokens-limit',
  'anthropic-ratelimit-priority-output-tokens-remaining',
  'anthropic-ratelimit-priority-output-tokens-reset',
  'retry-after',
  'x-ratelimit-limit-requests',
  'x-ratelimit-remaining-requests',
  'x-ratelimit-reset-requests',
  'x-ratelimit-limit-tokens',
  'x-ratelimit-remaining-tokens',
  'x-ratelimit-reset-tokens',
  'x-ratelimit-limit-project-tokens',
  'x-ratelimit-remaining-project-tokens',
  'x-ratelimit-reset-project-tokens',
] as const;

type CredentialSource = 'user' | 'project' | 'platform';
type CredentialLimitStatus = 'allowed' | 'allowed_warning' | 'rejected' | 'unknown';
type CredentialLimitLevel = 'ok' | 'warning' | 'critical' | 'rejected';
type CredentialLimitTransition = keyof typeof CREDENTIAL_LIMIT_EVENT_TYPES;

export type CredentialLimitObservation = {
  projectId: string;
  userId: string;
  credentialReference: string;
  credentialSource: CredentialSource;
  provider: string;
  providerMode: string;
  windowType: string;
  source: string;
  observedAt: number;
  status?: CredentialLimitStatus;
  agentType?: string | null;
  workspaceId?: string | null;
  agentSessionId?: string | null;
  chatSessionId?: string | null;
  utilizationPercent?: number | null;
  limitAmount?: number | null;
  remainingAmount?: number | null;
  windowMinutes?: number | null;
  resetsAt?: number | null;
  freshnessMs?: number | null;
};

export type CredentialLimitObservationResult =
  | { outcome: 'ignored'; reason: 'invalid' | 'stale' | 'duplicate' | 'ok' }
  | {
      outcome: 'event_admitted';
      transition: CredentialLimitTransition;
      eventType: string;
      deliveryKey: string;
    };

type CredentialLimitWindowRow = {
  status: CredentialLimitStatus;
  last_event_level: CredentialLimitLevel;
  utilization_percent: number | null;
  limit_amount: number | null;
  remaining_amount: number | null;
  window_minutes: number | null;
  resets_at: number | null;
  observed_at: number;
  stale_sample_count: number;
  duplicate_sample_count: number;
};

type CredentialLimitThresholds = {
  warningPercent: number;
  criticalPercent: number;
};

export type ProxyCredentialLimitContext = {
  projectId?: string | null;
  userId?: string | null;
  credentialReference?: string | null;
  credentialSource?: CredentialSource | string | null;
  provider: 'anthropic' | 'openai';
  providerMode: string;
  source: string;
  responseStatus?: number;
  agentType?: string | null;
  workspaceId?: string | null;
  agentSessionId?: string | null;
  chatSessionId?: string | null;
  observedAt?: number;
};

const PRODUCER_LIMITS = DEFAULT_PROJECT_EVENT_LIMITS;
const FILTER_STRING_MAX_BYTES = PRODUCER_LIMITS.maxFilterStringBytes;
const TEXT_MAX_BYTES = PRODUCER_LIMITS.maxReasonBytes;
const METADATA_MAX_DEPTH = PRODUCER_LIMITS.maxMetadataDepth;
const METADATA_MAX_KEYS = PRODUCER_LIMITS.maxMetadataKeys;
const METADATA_ARRAY_MAX_ITEMS = PRODUCER_LIMITS.maxMetadataArrayItems;
const DISPLAY_LABEL_MAX_COUNT = PRODUCER_LIMITS.maxDisplayLabels;
const TRUNCATION_SUFFIX = '...[truncated]';
const encoder = new TextEncoder();

function byteLength(value: string): number {
  return encoder.encode(value).byteLength;
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (byteLength(value) <= maxBytes) return value;
  const suffixBytes = byteLength(TRUNCATION_SUFFIX);
  const payloadMax = Math.max(0, maxBytes - suffixBytes);
  let low = 0;
  let high = value.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (byteLength(value.slice(0, mid)) <= payloadMax) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return `${value.slice(0, low)}${TRUNCATION_SUFFIX}`;
}

function boundedIdentifier(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return truncateUtf8(trimmed, FILTER_STRING_MAX_BYTES);
}

function boundedText(value: string | null | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return truncateUtf8(trimmed, TEXT_MAX_BYTES);
}

function normalizeJsonValue(
  value: ProjectEventJsonValue | undefined,
  depth = 0
): ProjectEventJsonValue | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') return truncateUtf8(value, TEXT_MAX_BYTES);
  if (Array.isArray(value)) {
    if (depth >= METADATA_MAX_DEPTH) return [];
    return value
      .slice(0, METADATA_ARRAY_MAX_ITEMS)
      .map((item) => normalizeJsonValue(item, depth + 1))
      .filter((item): item is ProjectEventJsonValue => item !== undefined);
  }
  if (typeof value === 'object') {
    if (depth >= METADATA_MAX_DEPTH) return {};
    const normalized: ProjectEventMetadata = {};
    for (const [key, nestedValue] of Object.entries(value)
      .filter(([, nestedValue]) => nestedValue !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .slice(0, METADATA_MAX_KEYS)) {
      const normalizedValue = normalizeJsonValue(nestedValue, depth + 1);
      if (normalizedValue !== undefined) {
        const normalizedKey = boundedIdentifier(key);
        if (normalizedKey) normalized[normalizedKey] = normalizedValue;
      }
    }
    return normalized;
  }
  return undefined;
}

function stableSort(value: ProjectEventJsonValue): ProjectEventJsonValue {
  if (Array.isArray(value)) return value.map(stableSort);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nestedValue]) => [key, stableSort(nestedValue)])
    );
  }
  return value;
}

function stableStringify(value: ProjectEventJsonValue): string {
  return JSON.stringify(stableSort(value));
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function fingerprint(value: ProjectEventJsonValue): Promise<string> {
  return `sha256:${await sha256Hex(stableStringify(value))}`;
}

function normalizeMetadata(input: Record<string, ProjectEventJsonValue | undefined>): ProjectEventMetadata {
  const normalized: ProjectEventMetadata = {};
  for (const [key, value] of Object.entries(input).slice(0, METADATA_MAX_KEYS)) {
    const normalizedValue = normalizeJsonValue(value);
    const normalizedKey = boundedIdentifier(key);
    if (normalizedKey && normalizedValue !== undefined) {
      normalized[normalizedKey] = normalizedValue;
    }
  }
  return normalized;
}

function normalizeNumber(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return value;
}

function normalizeInteger(value: number | null | undefined): number | null {
  const normalized = normalizeNumber(value);
  return normalized === null ? null : Math.trunc(normalized);
}

function normalizeNonNegativeInteger(value: number | null | undefined): number | null {
  const normalized = normalizeInteger(value);
  if (normalized === null || normalized < 0) return null;
  return normalized;
}

function normalizePercent(value: number | null | undefined): number | null {
  const normalized = normalizeNumber(value);
  if (normalized === null) return null;
  return Math.max(0, Math.min(100, normalized));
}

function normalizeTimestamp(value: number | null | undefined): number | null {
  const normalized = normalizeInteger(value);
  if (normalized === null || normalized < 0) return null;
  return normalized;
}

function normalizeCredentialSource(value: string | null | undefined): CredentialSource | null {
  return value === 'user' || value === 'project' || value === 'platform' ? value : null;
}

function normalizeStatus(value: string | null | undefined): CredentialLimitStatus {
  if (value === 'allowed' || value === 'allowed_warning' || value === 'rejected') return value;
  return 'unknown';
}

function thresholdsFromEnv(env: Env): CredentialLimitThresholds {
  const warningPercent = parseThreshold(
    env.CREDENTIAL_LIMIT_WARNING_PERCENT,
    DEFAULT_CREDENTIAL_LIMIT_WARNING_PERCENT
  );
  const criticalPercent = parseThreshold(
    env.CREDENTIAL_LIMIT_CRITICAL_PERCENT,
    DEFAULT_CREDENTIAL_LIMIT_CRITICAL_PERCENT
  );
  if (warningPercent > criticalPercent) {
    return {
      warningPercent: DEFAULT_CREDENTIAL_LIMIT_WARNING_PERCENT,
      criticalPercent: DEFAULT_CREDENTIAL_LIMIT_CRITICAL_PERCENT,
    };
  }
  return { warningPercent, criticalPercent };
}

function parseThreshold(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) return fallback;
  return parsed;
}

function levelRank(level: CredentialLimitLevel): number {
  switch (level) {
    case 'ok':
      return 0;
    case 'warning':
      return 1;
    case 'critical':
      return 2;
    case 'rejected':
      return 3;
  }
}

function computeLevel(
  status: CredentialLimitStatus,
  utilizationPercent: number | null,
  thresholds: CredentialLimitThresholds
): CredentialLimitLevel {
  if (status === 'rejected') return 'rejected';
  if (utilizationPercent !== null && utilizationPercent >= thresholds.criticalPercent) {
    return 'critical';
  }
  if (
    status === 'allowed_warning' ||
    (utilizationPercent !== null && utilizationPercent >= thresholds.warningPercent)
  ) {
    return 'warning';
  }
  return 'ok';
}

function transitionFromLevels(
  previousLevel: CredentialLimitLevel | null,
  nextLevel: CredentialLimitLevel
): CredentialLimitTransition | null {
  if (previousLevel === nextLevel) return null;
  if (nextLevel === 'ok') return previousLevel && previousLevel !== 'ok' ? 'reset' : null;
  if (previousLevel && levelRank(nextLevel) < levelRank(previousLevel)) {
    return nextLevel === 'warning' ? 'warning' : null;
  }
  return nextLevel;
}

function sanitizeObservation(input: CredentialLimitObservation): CredentialLimitObservation | null {
  const projectId = boundedIdentifier(input.projectId);
  const userId = boundedIdentifier(input.userId);
  const credentialReference = boundedIdentifier(input.credentialReference);
  const credentialSource = normalizeCredentialSource(input.credentialSource);
  const provider = boundedIdentifier(input.provider);
  const providerMode = boundedIdentifier(input.providerMode);
  const windowType = boundedIdentifier(input.windowType);
  const source = boundedIdentifier(input.source);
  const observedAt = normalizeTimestamp(input.observedAt);
  if (
    !projectId ||
    !userId ||
    !credentialReference ||
    !credentialSource ||
    !provider ||
    !providerMode ||
    !windowType ||
    !source ||
    observedAt === null
  ) {
    return null;
  }
  const freshnessMs = normalizeNonNegativeInteger(input.freshnessMs) ?? 0;
  return {
    projectId,
    userId,
    credentialReference,
    credentialSource,
    provider,
    providerMode,
    windowType,
    source,
    observedAt,
    status: normalizeStatus(input.status),
    agentType: boundedIdentifier(input.agentType) ?? null,
    workspaceId: boundedIdentifier(input.workspaceId) ?? null,
    agentSessionId: boundedIdentifier(input.agentSessionId) ?? null,
    chatSessionId: boundedIdentifier(input.chatSessionId) ?? null,
    utilizationPercent: normalizePercent(input.utilizationPercent),
    limitAmount: normalizeNonNegativeInteger(input.limitAmount),
    remainingAmount: normalizeNonNegativeInteger(input.remainingAmount),
    windowMinutes: normalizeNonNegativeInteger(input.windowMinutes),
    resetsAt: normalizeTimestamp(input.resetsAt),
    freshnessMs,
  };
}

async function loadWindow(
  env: Env,
  observation: CredentialLimitObservation
): Promise<CredentialLimitWindowRow | null> {
  return env.DATABASE.prepare(
    `SELECT status, last_event_level, utilization_percent, limit_amount, remaining_amount,
            window_minutes, resets_at, observed_at, stale_sample_count, duplicate_sample_count
       FROM credential_limit_windows
      WHERE project_id = ? AND credential_reference = ? AND window_type = ?`
  )
    .bind(observation.projectId, observation.credentialReference, observation.windowType)
    .first<CredentialLimitWindowRow>();
}

async function updateStaleSample(env: Env, observation: CredentialLimitObservation): Promise<void> {
  await env.DATABASE.prepare(
    `UPDATE credential_limit_windows
        SET stale_sample_count = MIN(stale_sample_count + 1, 2147483647),
            updated_at = ?
      WHERE project_id = ? AND credential_reference = ? AND window_type = ?`
  )
    .bind(Date.now(), observation.projectId, observation.credentialReference, observation.windowType)
    .run();
}

async function updateDuplicateSample(env: Env, observation: CredentialLimitObservation): Promise<void> {
  await env.DATABASE.prepare(
    `UPDATE credential_limit_windows
        SET duplicate_sample_count = MIN(duplicate_sample_count + 1, 2147483647),
            updated_at = ?
      WHERE project_id = ? AND credential_reference = ? AND window_type = ?`
  )
    .bind(Date.now(), observation.projectId, observation.credentialReference, observation.windowType)
    .run();
}

function sameSample(
  row: CredentialLimitWindowRow,
  observation: CredentialLimitObservation,
  level: CredentialLimitLevel
): boolean {
  return (
    row.status === (observation.status ?? 'unknown') &&
    row.last_event_level === level &&
    nullableNumberEquals(row.utilization_percent, observation.utilizationPercent ?? null) &&
    nullableNumberEquals(row.limit_amount, observation.limitAmount ?? null) &&
    nullableNumberEquals(row.remaining_amount, observation.remainingAmount ?? null) &&
    nullableNumberEquals(row.window_minutes, observation.windowMinutes ?? null) &&
    nullableNumberEquals(row.resets_at, observation.resetsAt ?? null)
  );
}

function nullableNumberEquals(left: number | null, right: number | null): boolean {
  if (left === null || right === null) return left === right;
  return Math.abs(left - right) < 0.000001;
}

async function upsertWindow(
  env: Env,
  observation: CredentialLimitObservation,
  level: CredentialLimitLevel,
  deliveryKey: string | null
): Promise<void> {
  const now = Date.now();
  await env.DATABASE.prepare(
    `INSERT INTO credential_limit_windows (
        project_id, credential_reference, window_type, credential_source, provider, provider_mode,
        agent_type, user_id, workspace_id, agent_session_id, chat_session_id, source, status,
        last_event_level, utilization_percent, limit_amount, remaining_amount, window_minutes,
        resets_at, observed_at, freshness_ms, last_event_delivery_key, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_id, credential_reference, window_type) DO UPDATE SET
        credential_source = excluded.credential_source,
        provider = excluded.provider,
        provider_mode = excluded.provider_mode,
        agent_type = excluded.agent_type,
        user_id = excluded.user_id,
        workspace_id = excluded.workspace_id,
        agent_session_id = excluded.agent_session_id,
        chat_session_id = excluded.chat_session_id,
        source = excluded.source,
        status = excluded.status,
        last_event_level = excluded.last_event_level,
        utilization_percent = excluded.utilization_percent,
        limit_amount = excluded.limit_amount,
        remaining_amount = excluded.remaining_amount,
        window_minutes = excluded.window_minutes,
        resets_at = excluded.resets_at,
        observed_at = excluded.observed_at,
        freshness_ms = excluded.freshness_ms,
        last_event_delivery_key = excluded.last_event_delivery_key,
        updated_at = excluded.updated_at
      WHERE excluded.observed_at > credential_limit_windows.observed_at`
  )
    .bind(
      observation.projectId,
      observation.credentialReference,
      observation.windowType,
      observation.credentialSource,
      observation.provider,
      observation.providerMode,
      observation.agentType ?? null,
      observation.userId,
      observation.workspaceId ?? null,
      observation.agentSessionId ?? null,
      observation.chatSessionId ?? null,
      observation.source,
      observation.status ?? 'unknown',
      level,
      observation.utilizationPercent ?? null,
      observation.limitAmount ?? null,
      observation.remainingAmount ?? null,
      observation.windowMinutes ?? null,
      observation.resetsAt ?? null,
      observation.observedAt,
      observation.freshnessMs ?? 0,
      deliveryKey,
      now,
      now
    )
    .run();
}

function metadataForObservation(
  observation: CredentialLimitObservation,
  transition: CredentialLimitTransition,
  level: CredentialLimitLevel,
  thresholds: CredentialLimitThresholds
): ProjectEventMetadata {
  return normalizeMetadata({
    transition,
    level,
    provider: observation.provider,
    providerMode: observation.providerMode,
    credentialSource: observation.credentialSource,
    credentialReference: observation.credentialReference,
    windowType: observation.windowType,
    source: observation.source,
    status: observation.status ?? 'unknown',
    observedAt: observation.observedAt,
    freshnessMs: observation.freshnessMs ?? 0,
    resetsAt: observation.resetsAt ?? undefined,
    windowMinutes: observation.windowMinutes ?? undefined,
    utilizationPercent: observation.utilizationPercent ?? undefined,
    limitAmount: observation.limitAmount ?? undefined,
    remainingAmount: observation.remainingAmount ?? undefined,
    thresholdWarningPercent: thresholds.warningPercent,
    thresholdCriticalPercent: thresholds.criticalPercent,
    advisoryOnly: true,
    workspaceId: observation.workspaceId ?? undefined,
    agentSessionId: observation.agentSessionId ?? undefined,
    chatSessionId: observation.chatSessionId ?? undefined,
    agentType: observation.agentType ?? undefined,
  });
}

function severityForTransition(transition: CredentialLimitTransition): ProjectEventSeverity {
  switch (transition) {
    case 'warning':
      return 'warning';
    case 'critical':
    case 'rejected':
      return 'critical';
    case 'reset':
      return 'notice';
  }
}

function displayForObservation(
  observation: CredentialLimitObservation,
  transition: CredentialLimitTransition
): AdmitProjectEventInput['display'] {
  const titleByTransition: Record<CredentialLimitTransition, string> = {
    warning: 'Credential limit warning',
    critical: 'Credential limit critical',
    rejected: 'Credential limit rejected request',
    reset: 'Credential limit reset',
  };
  const utilization =
    observation.utilizationPercent === null || observation.utilizationPercent === undefined
      ? null
      : `${Math.round(observation.utilizationPercent)}%`;
  const summaryParts = [
    observation.provider,
    observation.windowType,
    utilization ? `utilization ${utilization}` : null,
    observation.resetsAt ? `resets ${new Date(observation.resetsAt).toISOString()}` : null,
  ].filter((part): part is string => Boolean(part));
  const labels = [
    observation.provider,
    observation.windowType,
    observation.credentialSource,
    transition,
  ].slice(0, DISPLAY_LABEL_MAX_COUNT);
  return {
    title: boundedText(titleByTransition[transition]),
    summary: boundedText(summaryParts.join(' · ')),
    labels: labels
      .map((label) => boundedIdentifier(label))
      .filter((label): label is string => Boolean(label)),
  };
}

async function buildEventInput(
  observation: CredentialLimitObservation,
  transition: CredentialLimitTransition,
  level: CredentialLimitLevel,
  thresholds: CredentialLimitThresholds
): Promise<AdmitProjectEventInput> {
  const eventType = CREDENTIAL_LIMIT_EVENT_TYPES[transition];
  const subject = {
    type: 'credential',
    id: observation.credentialReference,
  };
  const metadata = metadataForObservation(observation, transition, level, thresholds);
  const display = displayForObservation(observation, transition);
  const deliverySeed = stableStringify({
    projectId: observation.projectId,
    credentialReference: observation.credentialReference,
    windowType: observation.windowType,
    transition,
    resetIdentity: observation.resetsAt ?? observation.observedAt,
    source: observation.source,
  });
  const deliveryKey = `credential-limit:${(await sha256Hex(deliverySeed)).slice(0, 48)}`;
  return {
    projectId: observation.projectId,
    source: CREDENTIAL_LIMIT_EVENT_SOURCE,
    eventType,
    subject,
    severity: severityForTransition(transition),
    deliveryKey,
    payloadFingerprint: await fingerprint({
      source: CREDENTIAL_LIMIT_EVENT_SOURCE,
      eventType,
      subject,
      severity: severityForTransition(transition),
      metadata,
      display: (display ?? {}) as ProjectEventJsonValue,
    }),
    metadata,
    display,
    occurredAt: observation.observedAt,
    receivedAt: observation.observedAt + (observation.freshnessMs ?? 0),
  };
}

export async function recordCredentialLimitObservation(
  env: Env,
  input: CredentialLimitObservation
): Promise<CredentialLimitObservationResult> {
  const observation = sanitizeObservation(input);
  if (!observation) return { outcome: 'ignored', reason: 'invalid' };

  const thresholds = thresholdsFromEnv(env);
  const level = computeLevel(observation.status ?? 'unknown', observation.utilizationPercent ?? null, thresholds);
  const existing = await loadWindow(env, observation);

  if (existing && observation.observedAt < existing.observed_at) {
    await updateStaleSample(env, observation);
    return { outcome: 'ignored', reason: 'stale' };
  }
  if (existing && observation.observedAt === existing.observed_at) {
    if (sameSample(existing, observation, level)) {
      await updateDuplicateSample(env, observation);
      return { outcome: 'ignored', reason: 'duplicate' };
    }
    await updateStaleSample(env, observation);
    return { outcome: 'ignored', reason: 'stale' };
  }

  const transition = transitionFromLevels(existing?.last_event_level ?? null, level);
  if (!transition) {
    await upsertWindow(env, observation, level, null);
    return { outcome: 'ignored', reason: 'ok' };
  }

  const eventInput = await buildEventInput(observation, transition, level, thresholds);
  const { projectId, ...withoutProjectId } = eventInput;
  await projectDataService.admitProjectEvent(env, projectId, withoutProjectId);
  await upsertWindow(env, observation, level, eventInput.deliveryKey);
  return {
    outcome: 'event_admitted',
    transition,
    eventType: eventInput.eventType,
    deliveryKey: eventInput.deliveryKey,
  };
}

export async function recordCredentialLimitObservations(
  env: Env,
  observations: CredentialLimitObservation[]
): Promise<CredentialLimitObservationResult[]> {
  const results: CredentialLimitObservationResult[] = [];
  for (const observation of observations) {
    results.push(await recordCredentialLimitObservation(env, observation));
  }
  return results;
}

export async function recordCredentialLimitObservationsBestEffort(
  env: Env,
  observations: CredentialLimitObservation[],
  context: { projectId?: string | null; source: string }
): Promise<void> {
  if (observations.length === 0) return;
  try {
    await recordCredentialLimitObservations(env, observations);
  } catch (err) {
    log.warn('credential_limit.observation_record_failed', {
      projectId: context.projectId ?? null,
      source: context.source,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function parseIntegerHeader(headers: Headers, name: string): number | null {
  const value = headers.get(name);
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

function utilizationFromLimitRemaining(limit: number | null, remaining: number | null): number | null {
  if (limit === null || remaining === null || limit <= 0 || remaining < 0) return null;
  return Math.max(0, Math.min(100, ((limit - remaining) / limit) * 100));
}

function parseRetryAfter(value: string | null, observedAt: number): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds)) return observedAt + Math.max(0, Math.trunc(seconds * 1000));
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseAnthropicReset(headers: Headers, name: string): number | null {
  const value = headers.get(name);
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseOpenAIReset(headers: Headers, name: string, observedAt: number): number | null {
  const value = headers.get(name);
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const durationMs = parseOpenAIDurationMs(trimmed);
  if (durationMs !== null) return observedAt + durationMs;
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

export function parseOpenAIDurationMs(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^\d+(\.\d+)?ms$/i.test(trimmed)) {
    return Math.max(0, Math.trunc(Number(trimmed.slice(0, -2))));
  }
  if (/^\d+(\.\d+)?s$/i.test(trimmed)) {
    return Math.max(0, Math.trunc(Number(trimmed.slice(0, -1)) * 1000));
  }
  if (/^\d+(\.\d+)?m$/i.test(trimmed)) {
    return Math.max(0, Math.trunc(Number(trimmed.slice(0, -1)) * 60_000));
  }
  if (/^\d+(\.\d+)?h$/i.test(trimmed)) {
    return Math.max(0, Math.trunc(Number(trimmed.slice(0, -1)) * 3_600_000));
  }
  let totalMs = 0;
  let matched = false;
  const pattern = /(\d+(?:\.\d+)?)(ms|s|m|h)/gi;
  for (const match of trimmed.matchAll(pattern)) {
    matched = true;
    const amountText = match[1];
    const unitText = match[2];
    if (!amountText || !unitText) return null;
    const amount = Number(amountText);
    const unit = unitText.toLowerCase();
    if (!Number.isFinite(amount)) return null;
    if (unit === 'ms') totalMs += amount;
    if (unit === 's') totalMs += amount * 1000;
    if (unit === 'm') totalMs += amount * 60_000;
    if (unit === 'h') totalMs += amount * 3_600_000;
  }
  return matched ? Math.max(0, Math.trunc(totalMs)) : null;
}

function proxyContextIsRecordable(
  context: ProxyCredentialLimitContext
): context is ProxyCredentialLimitContext & {
  projectId: string;
  userId: string;
  credentialReference: string;
  credentialSource: CredentialSource;
} {
  return Boolean(
    context.projectId &&
      context.userId &&
      context.credentialReference &&
      normalizeCredentialSource(context.credentialSource ?? null)
  );
}

export function extractCredentialLimitObservationsFromHeaders(
  headers: Headers,
  context: ProxyCredentialLimitContext
): CredentialLimitObservation[] {
  if (!proxyContextIsRecordable(context)) return [];
  const credentialSource = normalizeCredentialSource(context.credentialSource);
  if (!credentialSource) return [];
  const observedAt = normalizeTimestamp(context.observedAt) ?? Date.now();
  const status: CredentialLimitStatus = context.responseStatus === 429 ? 'rejected' : 'unknown';
  const base = {
    projectId: context.projectId,
    userId: context.userId,
    credentialReference: context.credentialReference,
    credentialSource,
    provider: context.provider,
    providerMode: context.providerMode,
    source: context.source,
    observedAt,
    status,
    agentType: context.agentType ?? null,
    workspaceId: context.workspaceId ?? null,
    agentSessionId: context.agentSessionId ?? null,
    chatSessionId: context.chatSessionId ?? null,
    freshnessMs: 0,
  } satisfies Omit<CredentialLimitObservation, 'windowType'>;

  const observations =
    context.provider === 'anthropic'
      ? extractAnthropicObservations(headers, base)
      : extractOpenAIObservations(headers, base);

  if (observations.length === 0 && context.responseStatus === 429) {
    const reset = parseRetryAfter(headers.get('retry-after'), observedAt);
    observations.push({
      ...base,
      status: 'rejected',
      windowType: `${context.provider}.requests`,
      resetsAt: reset,
    });
  }
  return observations;
}

function extractAnthropicObservations(
  headers: Headers,
  base: Omit<CredentialLimitObservation, 'windowType'>
): CredentialLimitObservation[] {
  const groups = ['requests', 'tokens', 'input-tokens', 'output-tokens', 'priority-input-tokens', 'priority-output-tokens'];
  return groups.flatMap((group) => {
    const limit = parseIntegerHeader(headers, `anthropic-ratelimit-${group}-limit`);
    const remaining = parseIntegerHeader(headers, `anthropic-ratelimit-${group}-remaining`);
    const resetsAt = parseAnthropicReset(headers, `anthropic-ratelimit-${group}-reset`);
    if (limit === null && remaining === null && resetsAt === null) return [];
    return [
      {
        ...base,
        windowType: `anthropic.${group}`,
        utilizationPercent: utilizationFromLimitRemaining(limit, remaining),
        limitAmount: limit,
        remainingAmount: remaining,
        resetsAt,
      },
    ];
  });
}

function extractOpenAIObservations(
  headers: Headers,
  base: Omit<CredentialLimitObservation, 'windowType'>
): CredentialLimitObservation[] {
  const groups = [
    ['requests', 'requests'],
    ['tokens', 'tokens'],
    ['project-tokens', 'project-tokens'],
  ] as const;
  return groups.flatMap(([windowName, headerName]) => {
    const limit = parseIntegerHeader(headers, `x-ratelimit-limit-${headerName}`);
    const remaining = parseIntegerHeader(headers, `x-ratelimit-remaining-${headerName}`);
    const resetsAt = parseOpenAIReset(headers, `x-ratelimit-reset-${headerName}`, base.observedAt);
    if (limit === null && remaining === null && resetsAt === null) return [];
    return [
      {
        ...base,
        windowType: `openai.${windowName}`,
        utilizationPercent: utilizationFromLimitRemaining(limit, remaining),
        limitAmount: limit,
        remainingAmount: remaining,
        resetsAt,
      },
    ];
  });
}

export async function recordProxyCredentialLimitObservationsFromHeaders(
  env: Env,
  headers: Headers,
  context: ProxyCredentialLimitContext
): Promise<void> {
  const observations = extractCredentialLimitObservationsFromHeaders(headers, context);
  await recordCredentialLimitObservationsBestEffort(env, observations, {
    projectId: context.projectId,
    source: context.source,
  });
}

export function copyCredentialLimitHeaders(source: Headers, target: Headers): void {
  for (const name of CREDENTIAL_LIMIT_PROVIDER_HEADERS) {
    const value = source.get(name);
    if (value) target.set(name, value);
  }
}
