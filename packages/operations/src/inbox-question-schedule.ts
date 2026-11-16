/**
 * The schedule of an agent question (`request_human_input`): its window, its reminders, the grace
 * an undelivered question gets and its hard limit. The rules are the ones the ProjectData marker
 * alarm used (`computeHumanInputSchedule`, `advanceAttentionEscalation`,
 * `packages/project-data/src/do/attention.ts`); the values are admin settings `inbox.question*`.
 */
import type { InboxLimits } from './inbox-settings';

const MINUTE_MS = 60_000;

type QuestionLimits = Pick<
  InboxLimits,
  | 'questionTimeoutMinutes'
  | 'questionFirstReminderPercent'
  | 'questionSecondReminderPercent'
  | 'questionUndeliveredGraceMinutes'
  | 'questionMaxWaitMinutes'
>;

/** Reminder points as fractions of the window, ascending, without duplicates or zeros. */
export function questionReminderFractions(limits: QuestionLimits): number[] {
  const fractions = [limits.questionFirstReminderPercent, limits.questionSecondReminderPercent]
    .filter((percent) => percent > 0 && percent < 100)
    .map((percent) => percent / 100);
  return [...new Set(fractions)].sort((left, right) => left - right);
}

export function questionSchedule(
  limits: QuestionLimits,
  now: number
): { expiresAt: number; nextEscalationAt: number | null; maxExpiresAt: number } {
  const timeout = limits.questionTimeoutMinutes * MINUTE_MS;
  const maxWait = Math.max(timeout, limits.questionMaxWaitMinutes * MINUTE_MS);
  const first = questionReminderFractions(limits)[0];
  return {
    expiresAt: now + timeout,
    nextEscalationAt: first === undefined ? null : now + Math.round(timeout * first),
    maxExpiresAt: now + maxWait,
  };
}

/** When the reminder after `escalationCount` is due, or null when none is left. */
export function nextQuestionReminderAt(
  ask: { createdAt: number; expiresAt: number | null; escalationCount: number },
  limits: QuestionLimits
): number | null {
  const fraction = questionReminderFractions(limits)[ask.escalationCount + 1];
  if (fraction === undefined) return null;
  const window = Math.max(0, (ask.expiresAt ?? ask.createdAt) - ask.createdAt);
  return ask.createdAt + Math.round(window * fraction);
}

/** How far an undelivered question is extended, capped at its hard limit. */
export function questionUndeliveredExtension(
  limits: QuestionLimits,
  ask: { createdAt: number; maxExpiresAt: number | null },
  now: number
): { maxExpiresAt: number; extendedExpiry: number } {
  const maxExpiresAt =
    ask.maxExpiresAt ??
    ask.createdAt +
      Math.max(limits.questionTimeoutMinutes, limits.questionMaxWaitMinutes) * MINUTE_MS;
  return {
    maxExpiresAt,
    extendedExpiry: Math.min(maxExpiresAt, now + limits.questionUndeliveredGraceMinutes * MINUTE_MS),
  };
}
