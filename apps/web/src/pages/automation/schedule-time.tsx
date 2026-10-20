/**
 * Picking when a one-time automation runs: a wall-clock time in a chosen zone, and how long SAM
 * may keep trying if it cannot start on time. Shared by the editor and "Change time".
 */
import {
  DEFAULT_PROJECT_EVENT_SCHEDULE_LATE_GRACE_MS,
  DEFAULT_PROJECT_EVENT_SCHEDULE_MAX_HORIZON_MS,
} from '@simple-agent-manager/shared';

import { formatSpanWords } from '../../lib/time-utils';
import { Field, INPUT_CLASS, ZoneSelect } from './fields';
import { fullDate, instantToZonedInput, zonedInputToInstant } from './time';

const MIN = 60_000;

/** How long SAM may keep trying after the due time; the API allows up to the late grace. */
export const GIVE_UP_OPTIONS = [
  15 * MIN,
  60 * MIN,
  6 * 60 * MIN,
  DEFAULT_PROJECT_EVENT_SCHEDULE_LATE_GRACE_MS,
]
  .filter((ms) => ms <= DEFAULT_PROJECT_EVENT_SCHEDULE_LATE_GRACE_MS)
  .map((ms) => ({ ms, label: formatSpanWords(ms) }));

export const DEFAULT_GIVE_UP_MS = DEFAULT_PROJECT_EVENT_SCHEDULE_LATE_GRACE_MS;

/** The closest offered give-up window for an existing schedule's gap. */
export function nearestGiveUp(gapMs: number): number {
  const fit = GIVE_UP_OPTIONS.filter((option) => option.ms <= gapMs).at(-1);
  return (fit ?? GIVE_UP_OPTIONS[0] ?? { ms: DEFAULT_GIVE_UP_MS }).ms;
}

export interface OnceTime {
  /** datetime-local value, wall clock in `zone`. */
  local: string;
  zone: string;
  giveUpMs: number;
}

export function onceTimeFrom(dueAt: number, zone: string, expiresAt?: number): OnceTime {
  return {
    local: instantToZonedInput(dueAt, zone),
    zone,
    giveUpMs: expiresAt ? nearestGiveUp(expiresAt - dueAt) : DEFAULT_GIVE_UP_MS,
  };
}

/** The due and give-up instants, or the reason the time cannot be used. */
export function resolveOnceTime(
  time: OnceTime,
  now = Date.now()
): { dueAt: number; expiresAt: number } | { error: string } {
  const dueAt = zonedInputToInstant(time.local, time.zone);
  if (dueAt === null) return { error: 'Choose a date and time.' };
  if (dueAt <= now) return { error: 'Choose a time in the future.' };
  if (dueAt - now > DEFAULT_PROJECT_EVENT_SCHEDULE_MAX_HORIZON_MS)
    return {
      error: `Choose a time within the next ${formatSpanWords(DEFAULT_PROJECT_EVENT_SCHEDULE_MAX_HORIZON_MS)}.`,
    };
  return { dueAt, expiresAt: dueAt + time.giveUpMs };
}

export function OnceTimeFields({
  value,
  onChange,
  error,
}: {
  value: OnceTime;
  onChange: (value: OnceTime) => void;
  error?: string | null;
}) {
  const resolved = resolveOnceTime(value);
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Date and time" error={error}>
          {({ id, describedBy, invalid }) => (
            <input
              id={id}
              type="datetime-local"
              className={INPUT_CLASS}
              value={value.local}
              aria-describedby={describedBy}
              aria-invalid={invalid}
              onChange={(event) => onChange({ ...value, local: event.target.value })}
            />
          )}
        </Field>
        <Field label="Time zone">
          {({ id, describedBy }) => (
            <ZoneSelect
              id={id}
              value={value.zone}
              describedBy={describedBy}
              onChange={(zone) => onChange({ ...value, zone })}
            />
          )}
        </Field>
      </div>
      <Field
        label="If it cannot start on time, keep trying for"
        hint="A busy chat or a full machine can delay it. After this, SAM gives up and tells you."
      >
        {({ id, describedBy }) => (
          <select
            id={id}
            value={value.giveUpMs}
            aria-describedby={describedBy}
            onChange={(event) => onChange({ ...value, giveUpMs: Number(event.target.value) })}
          >
            {GIVE_UP_OPTIONS.map((option) => (
              <option key={option.ms} value={option.ms}>
                {option.label}
              </option>
            ))}
          </select>
        )}
      </Field>
      {'dueAt' in resolved && (
        <p className="m-0 text-[13px] text-fg-muted">Runs {fullDate(resolved.dueAt)} your time.</p>
      )}
    </div>
  );
}
