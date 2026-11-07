/** Bounded provider waiting policy; optional deployment overrides keep code defaults. */
import * as v from 'valibot';

export const PROVIDER_LIMIT_POLICY = Object.freeze({
  maxWindows: 100,
  maxConsecutiveWaits: 3,
  unknownBackoffMs: 5 * 60_000,
  maxUnknownBackoffMs: 30 * 60_000,
  recentRejectionMs: 2 * 60_000,
  maxResetDelayMs: 8 * 24 * 60 * 60_000,
  resetGraceMs: 10_000,
  resetWindowToleranceMs: 60_000,
  resetJitterMs: 20_000,
  deadlineGraceMs: 30 * 60_000,
  snapshotMarginMs: 10 * 60_000,
});
const timestamp = v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(8_640_000_000_000_000));
export const ProviderLimitWaitSchema = v.object({
  version: v.literal(1),
  phase: v.picklist(['waiting', 'blocked', 'released']),
  origin: v.picklist(['callback', 'admission']),
  attempts: v.pipe(
    v.number(),
    v.integer(),
    v.minValue(1),
    v.maxValue(PROVIDER_LIMIT_POLICY.maxConsecutiveWaits + 1)
  ),
  credentialKey: v.nullable(v.string()),
  incidentId: v.string(),
  observedAt: timestamp,
  resetsAt: v.nullable(timestamp),
  nextRetryAt: timestamp,
  deadlineAt: timestamp,
  scheduleKey: v.string(),
  scheduleId: v.optional(v.string()),
  sourceAgentSessionId: v.optional(v.string()),
  sourceCredentialGeneration: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
  reason: v.string(),
});
export type ProviderLimitWait = v.InferOutput<typeof ProviderLimitWaitSchema>;
export function parseProviderLimitWait(json: string | null | undefined): ProviderLimitWait | null {
  if (!json) return null;
  try {
    const parsed = v.safeParse(ProviderLimitWaitSchema, JSON.parse(json));
    return parsed.success ? parsed.output : null;
  } catch {
    return null;
  }
}
export const PROVIDER_LIMIT_CONTINUATION =
  'SAM paused this task because its provider usage limit rejected a prompt. The waiting period has ended. ' +
  'Continue the assigned task using the same model, profile and credential. Read get_instructions and the durable task state, transcript and Git status first. ' +
  'The last prompt may have performed work before the rejection: inspect receipts and existing effects before repeating any action. Do not blindly replay the original prompt or ambiguous in-flight work. ' +
  'If SAM reports degraded restoration, inspect the retained recovery point and explain the gap before continuing.';

function providerLimitJitter(): number {
  return (crypto.getRandomValues(new Uint32Array(1))[0] ?? 0) / 0x1_0000_0000;
}

export function newProviderLimitWait(input: {
  taskId: string;
  origin: ProviderLimitWait['origin'];
  incidentId: string;
  credentialKey: string | null;
  previous: ProviderLimitWait | null;
  now: number;
  resetsAt: number | null;
  snapshotExpiresAt?: number | null;
  jitter?: number;
  resetWindowToleranceMs?: number;
}): ProviderLimitWait {
  const reset =
    input.resetsAt &&
    input.resetsAt > input.now &&
    input.resetsAt <= input.now + PROVIDER_LIMIT_POLICY.maxResetDelayMs
      ? input.resetsAt
      : null;
  // Provider timestamps may be rounded differently by successive rejections.
  // A pending unknown retry is also one wait, regardless of prompt count.
  const sameCredential = input.previous?.credentialKey === input.credentialKey;
  const sameWindow =
    !!input.previous &&
    sameCredential &&
    ((reset !== null &&
      input.previous.resetsAt !== null &&
      Math.abs(reset - input.previous.resetsAt) <=
        (input.resetWindowToleranceMs ?? PROVIDER_LIMIT_POLICY.resetWindowToleranceMs)) ||
      (reset === null &&
        input.previous.resetsAt === null &&
        input.previous.phase === 'waiting' &&
        input.now < input.previous.nextRetryAt));
  const matchingWait = sameWindow ? input.previous : null;
  const attempts =
    matchingWait?.attempts ??
    Math.min(
      (reset === null && input.previous?.resetsAt !== null ? 0 : (input.previous?.attempts ?? 0)) +
        1,
      PROVIDER_LIMIT_POLICY.maxConsecutiveWaits + 1
    );
  // A rounded reset can still be in the future after the prior alarm became due.
  const reusableWait = matchingWait && matchingWait.nextRetryAt > input.now ? matchingWait : null;
  const nextRetryAt = reusableWait
    ? reusableWait.nextRetryAt
    : reset
      ? reset +
        PROVIDER_LIMIT_POLICY.resetGraceMs +
        Math.floor(
          Math.max(0, Math.min(1, input.jitter ?? providerLimitJitter())) *
            PROVIDER_LIMIT_POLICY.resetJitterMs
        )
      : input.now +
        Math.min(
          PROVIDER_LIMIT_POLICY.unknownBackoffMs * 2 ** (attempts - 1),
          PROVIDER_LIMIT_POLICY.maxUnknownBackoffMs
        );
  const expires = input.snapshotExpiresAt;
  const outlivesSnapshot =
    expires != null && nextRetryAt >= expires - PROVIDER_LIMIT_POLICY.snapshotMarginMs;
  const changedCredential =
    input.previous?.credentialKey != null && input.previous.credentialKey !== input.credentialKey;
  const blocked =
    (reset === null && attempts > PROVIDER_LIMIT_POLICY.maxConsecutiveWaits) ||
    outlivesSnapshot ||
    changedCredential;
  const reason = changedCredential
    ? 'Blocked: selected provider credential changed; review before resuming.'
    : outlivesSnapshot
      ? 'Blocked: provider limit reset outlives the saved snapshot; will need a fresh start after the limit resets.'
      : blocked
        ? 'Blocked: provider limit wait budget exhausted. Review the provider limit before resuming.'
        : reset
          ? `Waiting for provider limit reset at ${new Date(reset).toISOString().slice(11, 16)} UTC (${new Date(reset).toISOString().slice(0, 10)}).`
          : `Waiting for provider limit reset (time unknown); bounded retry ${attempts}/${PROVIDER_LIMIT_POLICY.maxConsecutiveWaits} at ${new Date(nextRetryAt).toISOString().slice(11, 16)} UTC.`;
  return {
    version: 1,
    phase: blocked ? 'blocked' : 'waiting',
    origin: input.origin,
    attempts,
    credentialKey: input.credentialKey,
    incidentId: input.incidentId,
    observedAt: input.now,
    resetsAt: reusableWait ? reusableWait.resetsAt : reset,
    nextRetryAt,
    deadlineAt: nextRetryAt + PROVIDER_LIMIT_POLICY.deadlineGraceMs,
    scheduleKey: reusableWait
      ? reusableWait.scheduleKey
      : `provider-limit:${input.taskId}:${crypto.randomUUID()}`,
    ...(reusableWait?.scheduleId ? { scheduleId: reusableWait.scheduleId } : {}),
    reason: reusableWait && !blocked ? reusableWait.reason : reason,
  };
}

/** Short resets retain ordinary idle policy; blocked waits have no automatic wake. */
export function providerLimitNeedsImmediateSleep(
  wait: ProviderLimitWait | null,
  now: number,
  idleAfterMs: number
): boolean {
  return (
    !!wait &&
    (wait.phase === 'blocked' ||
      (wait.phase === 'waiting' && (wait.resetsAt === null || wait.resetsAt - now > idleAfterMs)))
  );
}
