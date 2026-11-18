/** "When should it run?" for a recurring schedule: presets first, a typed cron when needed. */
import { DAY_ABBREVIATIONS } from '../../../components/triggers/schedule-cron';
import { Field, INPUT_CLASS, ZoneSelect } from '../fields';
import { fullDate } from '../time';
import { Chips } from '../ui';
import { nextRuns, type ScheduleChoice, type SchedulePreset, toCron } from './cron';

const PRESETS: Array<{ id: SchedulePreset; label: string }> = [
  { id: 'daily', label: 'Every day' },
  { id: 'weekdays', label: 'Weekdays' },
  { id: 'weekends', label: 'Weekends' },
  { id: 'weekly', label: 'Weekly' },
  { id: 'monthly', label: 'Monthly' },
  { id: 'hourly', label: 'Every few hours' },
  { id: 'custom', label: 'Custom' },
];

const EVERY_HOURS = [1, 2, 3, 4, 6, 8, 12];
/** Monday first, the way most calendars read; cron numbers Sunday 0. */
const WEEK = [1, 2, 3, 4, 5, 6, 0];

export function ScheduleWhen({
  value,
  onChange,
  error,
}: {
  value: ScheduleChoice;
  onChange: (value: ScheduleChoice) => void;
  error?: string;
}) {
  const set = (patch: Partial<ScheduleChoice>) => onChange({ ...value, ...patch });
  const runs = nextRuns(value, Date.now());
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <span className="text-sm font-semibold text-fg-primary">How often?</span>
        <Chips
          wrap
          label="How often"
          value={value.preset}
          onChange={(preset) =>
            set({ preset, custom: preset === 'custom' ? toCron(value) : value.custom })
          }
          options={PRESETS}
        />
      </div>

      {value.preset === 'weekly' && (
        <div className="flex flex-col gap-2">
          <span className="text-sm font-semibold text-fg-primary">On</span>
          <div className="flex flex-wrap gap-2" role="group" aria-label="Days of the week">
            {WEEK.map((day) => {
              const on = value.weeklyDays.includes(day);
              return (
                <button
                  key={day}
                  type="button"
                  aria-pressed={on}
                  onClick={() =>
                    set({
                      weeklyDays: on
                        ? value.weeklyDays.filter((item) => item !== day)
                        : [...value.weeklyDays, day],
                    })
                  }
                  className={`h-11 min-w-11 cursor-pointer rounded-full border px-3 text-sm font-semibold ${
                    on
                      ? 'border-accent bg-[var(--sam-color-accent-primary-tint)] text-fg-primary'
                      : 'border-border-default bg-transparent text-fg-muted'
                  }`}
                >
                  {DAY_ABBREVIATIONS[day]}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {value.preset === 'custom' ? (
        <Field
          label="Cron expression"
          error={error}
          hint="Five parts: minute, hour, day of month, month, day of week. For example 0 9 * * 1-5 is 9:00 on weekdays."
        >
          {({ id, describedBy, invalid }) => (
            <input
              id={id}
              type="text"
              className="font-mono"
              spellCheck={false}
              value={value.custom}
              aria-describedby={describedBy}
              aria-invalid={invalid}
              onChange={(event) => set({ custom: event.target.value })}
            />
          )}
        </Field>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {value.preset === 'hourly' ? (
            <div className="grid grid-cols-2 gap-3">
              <Field label="Every">
                {({ id }) => (
                  <select
                    id={id}
                    value={value.everyHours}
                    onChange={(event) => set({ everyHours: Number(event.target.value) })}
                  >
                    {EVERY_HOURS.map((hours) => (
                      <option key={hours} value={hours}>
                        {hours === 1 ? 'hour' : `${hours} hours`}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
              <Field label="At minute">
                {({ id }) => (
                  <input
                    id={id}
                    type="number"
                    inputMode="numeric"
                    min={0}
                    max={59}
                    className={INPUT_CLASS}
                    value={value.minute}
                    onChange={(event) =>
                      set({ minute: Math.min(59, Math.max(0, Number(event.target.value) || 0)) })
                    }
                  />
                )}
              </Field>
            </div>
          ) : (
            <div className={value.preset === 'monthly' ? 'grid grid-cols-2 gap-3' : ''}>
              {value.preset === 'monthly' && (
                <Field label="On day">
                  {({ id }) => (
                    <input
                      id={id}
                      type="number"
                      inputMode="numeric"
                      min={1}
                      max={31}
                      className={INPUT_CLASS}
                      value={value.monthDay}
                      onChange={(event) =>
                        set({
                          monthDay: Math.min(31, Math.max(1, Number(event.target.value) || 1)),
                        })
                      }
                    />
                  )}
                </Field>
              )}
              <Field label="At">
                {({ id }) => (
                  <input
                    id={id}
                    type="time"
                    className={INPUT_CLASS}
                    value={value.time}
                    onChange={(event) => set({ time: event.target.value || '09:00' })}
                  />
                )}
              </Field>
            </div>
          )}
          <Field label="Time zone">
            {({ id }) => (
              <ZoneSelect id={id} value={value.zone} onChange={(zone) => set({ zone })} />
            )}
          </Field>
        </div>
      )}
      {value.preset === 'custom' && (
        <Field label="Time zone">
          {({ id }) => <ZoneSelect id={id} value={value.zone} onChange={(zone) => set({ zone })} />}
        </Field>
      )}
      {value.preset === 'weekly' && error && (
        <p role="alert" className="m-0 text-[13px] font-medium text-danger-fg">
          {error}
        </p>
      )}

      <div
        className="flex flex-col gap-2 rounded-xl border border-border-default bg-inset p-4"
        aria-live="polite"
      >
        <span className="text-[13px] font-medium text-fg-muted">Next runs, in your time</span>
        {runs.length ? (
          <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
            {runs.map((at) => (
              <li key={at} className="flex items-center gap-2 text-[15px] text-fg-primary">
                <span className="h-1.5 w-1.5 rounded-full bg-accent" aria-hidden />
                {fullDate(at)}
              </li>
            ))}
          </ul>
        ) : (
          <span className="text-sm text-fg-muted">SAM works out the run times when you save.</span>
        )}
        {value.preset === 'monthly' && value.monthDay > 28 && (
          <span className="text-xs text-fg-muted">
            Months without day {value.monthDay} are skipped.
          </span>
        )}
      </div>
    </div>
  );
}
