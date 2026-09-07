import type { Env } from '../../env';
import { log } from '../../lib/logger';
import {
  captureCredentialLimitEventAdmission,
  dispatchCredentialLimitAdmission,
  loadWindow,
  sameSample,
  updateDuplicateSample,
  updateStaleSample,
  upsertCredentialLimitWindow,
} from './admissions';
import { resolveCredentialLimitConfig } from './config';
import { buildEventInput, computeLevel, transitionFromLevels } from './event-builders';
import type {
  CredentialLimitLevel,
  CredentialLimitObservation,
  CredentialLimitObservationIgnoreReason,
  CredentialLimitObservationResult,
  CredentialLimitRuntimeConfig,
  SanitizedCredentialLimitObservation,
} from './types';
import {
  boundedIdentifier,
  normalizeCredentialSource,
  normalizeNonNegativeInteger,
  normalizePercent,
  normalizeStatus,
  normalizeTimestamp,
} from './values';

type SanitizedResult =
  | { ok: true; observation: SanitizedCredentialLimitObservation }
  | { ok: false; reason: CredentialLimitObservationIgnoreReason };

function sanitizeObservation(
  input: CredentialLimitObservation,
  config: CredentialLimitRuntimeConfig,
  serverReceivedAt: number
): SanitizedResult {
  const projectId = boundedIdentifier(input.projectId);
  const userId = boundedIdentifier(input.userId);
  const credentialReference = boundedIdentifier(input.credentialReference);
  const credentialSource = normalizeCredentialSource(input.credentialSource);
  const provider = boundedIdentifier(input.provider)?.toLowerCase() ?? null;
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
    return { ok: false, reason: 'invalid' };
  }
  if (!config.supportedProviders.has(provider) || !config.supportedSources.has(source)) {
    return { ok: false, reason: 'unsupported' };
  }
  if (!config.supportedWindowTypes.has(windowType)) return { ok: false, reason: 'unsupported' };
  if (observedAt < serverReceivedAt - config.observationMaxAgeMs) {
    return { ok: false, reason: 'too_old' };
  }
  if (observedAt > serverReceivedAt + config.observationFutureSkewMs) {
    return { ok: false, reason: 'future' };
  }

  const rawResetsAt = normalizeTimestamp(input.resetsAt);
  const resetsAt =
    rawResetsAt !== null && rawResetsAt <= serverReceivedAt + config.resetMaxFutureMs
      ? rawResetsAt
      : null;
  const freshnessMs = Math.max(0, serverReceivedAt - observedAt);

  return {
    ok: true,
    observation: {
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
      resetsAt,
      freshnessMs,
      serverReceivedAt,
    },
  };
}

function windowLevelForNonEdge(
  existingLevel: CredentialLimitLevel | null | undefined,
  computedLevel: CredentialLimitLevel | null
): CredentialLimitLevel {
  return computedLevel ?? existingLevel ?? 'ok';
}

export async function recordCredentialLimitObservation(
  env: Env,
  input: CredentialLimitObservation
): Promise<CredentialLimitObservationResult> {
  const config = resolveCredentialLimitConfig(env);
  const sanitized = sanitizeObservation(input, config, Date.now());
  if (!sanitized.ok) return { outcome: 'ignored', reason: sanitized.reason };
  const observation = sanitized.observation;

  const existing = await loadWindow(env, observation);
  const computedLevel = computeLevel(observation, config);
  const level = windowLevelForNonEdge(existing?.last_event_level, computedLevel);

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

  if (computedLevel === null) {
    await upsertCredentialLimitWindow(
      env,
      observation,
      level,
      existing?.last_event_delivery_key ?? null
    );
    return { outcome: 'ignored', reason: 'ok' };
  }

  const transition = transitionFromLevels(existing?.last_event_level ?? null, computedLevel);
  if (!transition) {
    await upsertCredentialLimitWindow(
      env,
      observation,
      computedLevel,
      existing?.last_event_delivery_key ?? null
    );
    return { outcome: 'ignored', reason: 'ok' };
  }

  const eventInput = await buildEventInput(
    observation,
    transition,
    computedLevel,
    existing?.last_event_level ?? null,
    config
  );
  const captured = await captureCredentialLimitEventAdmission(
    env,
    observation,
    computedLevel,
    eventInput,
    transition,
    config
  );

  if (captured.outcome === 'capacity') return { outcome: 'ignored', reason: 'capacity' };
  if (captured.outcome === 'stale') return { outcome: 'ignored', reason: 'stale' };
  if (captured.outcome === 'duplicate') return { outcome: 'ignored', reason: 'duplicate' };
  if (captured.outcome === 'conflict') {
    return {
      outcome: 'event_admitted',
      transition,
      eventType: eventInput.eventType,
      deliveryKey: eventInput.deliveryKey,
      admissionId: captured.admission?.id ?? '',
      admissionOutcome: 'conflict',
      dispatchOutcome: 'conflict',
    };
  }

  const dispatchOutcome = await dispatchCredentialLimitAdmission(env, captured.admission);

  return {
    outcome: 'event_admitted',
    transition,
    eventType: eventInput.eventType,
    deliveryKey: eventInput.deliveryKey,
    admissionId: captured.admission.id,
    admissionOutcome: captured.outcome,
    dispatchOutcome,
  };
}

export async function recordCredentialLimitObservations(
  env: Env,
  observations: CredentialLimitObservation[]
): Promise<CredentialLimitObservationResult[]> {
  const config = resolveCredentialLimitConfig(env);
  const limited = observations.slice(0, config.maxObservationsPerReport);
  const results: CredentialLimitObservationResult[] = [];
  for (const observation of limited) {
    const result = await recordCredentialLimitObservation(env, observation);
    results.push(result);
  }
  for (let index = limited.length; index < observations.length; index += 1) {
    results.push({ outcome: 'ignored', reason: 'capacity' });
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
