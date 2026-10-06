import { Alert, Input, Select } from '@simple-agent-manager/ui';
import { Check } from 'lucide-react';

import { StepHeader, WhyDetails } from './explain';

interface TriggerForm {
  name: string;
  description: string;
  cronExpression: string;
  cronTimezone: string;
  promptTemplate: string;
}

type SchedulePreset = 'daily' | 'weekdays' | 'weekly';

interface SimpleSchedule {
  preset: SchedulePreset;
  time: string;
  weekday: number;
}

const DEFAULT_SCHEDULE: SimpleSchedule = {
  preset: 'daily',
  time: '09:00',
  weekday: 1,
};

const SCHEDULE_PRESETS: Array<{
  id: SchedulePreset;
  title: string;
  description: string;
}> = [
  { id: 'daily', title: 'Daily', description: 'Every day' },
  { id: 'weekdays', title: 'Weekdays', description: 'Monday through Friday' },
  { id: 'weekly', title: 'Weekly', description: 'One day each week' },
];

const WEEKDAY_OPTIONS = [
  { value: 1, label: 'Monday' },
  { value: 2, label: 'Tuesday' },
  { value: 3, label: 'Wednesday' },
  { value: 4, label: 'Thursday' },
  { value: 5, label: 'Friday' },
  { value: 6, label: 'Saturday' },
  { value: 0, label: 'Sunday' },
];

const COMMON_TIMEZONES = [
  'UTC',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'Europe/London',
  'Europe/Paris',
  'Europe/Berlin',
  'Asia/Tokyo',
  'Asia/Shanghai',
  'Asia/Kolkata',
  'Australia/Sydney',
  'Pacific/Auckland',
];

const FOCUS_RING =
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring';

function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function padTimePart(value: number): string {
  return String(value).padStart(2, '0');
}

function timeFromParts(hour: number, minute: number): string {
  return `${padTimePart(hour)}:${padTimePart(minute)}`;
}

function parseSimpleSchedule(cronExpression: string): SimpleSchedule {
  const parts = cronExpression.trim().split(/\s+/);
  if (parts.length !== 5) return DEFAULT_SCHEDULE;

  const [minutePart = '', hourPart = '', dayOfMonth = '', month = '', dayOfWeek = ''] = parts;
  const minute = clamp(Number.parseInt(minutePart, 10), 0, 59);
  const hour = clamp(Number.parseInt(hourPart, 10), 0, 23);
  const time = timeFromParts(hour, minute);

  if (dayOfMonth !== '*' || month !== '*') return { ...DEFAULT_SCHEDULE, time };
  if (dayOfWeek === '*') return { preset: 'daily', time, weekday: 1 };
  if (dayOfWeek === '1-5' || dayOfWeek === '1,2,3,4,5') {
    return { preset: 'weekdays', time, weekday: 1 };
  }
  if (/^[0-6]$/.test(dayOfWeek)) {
    return { preset: 'weekly', time, weekday: Number.parseInt(dayOfWeek, 10) };
  }
  return { ...DEFAULT_SCHEDULE, time };
}

function buildCronExpression({ preset, time, weekday }: SimpleSchedule): string {
  const [rawHour = '9', rawMinute = '0'] = time.split(':');
  const hour = clamp(Number.parseInt(rawHour, 10), 0, 23);
  const minute = clamp(Number.parseInt(rawMinute, 10), 0, 59);

  if (preset === 'weekdays') return `${minute} ${hour} * * 1-5`;
  if (preset === 'weekly') return `${minute} ${hour} * * ${weekday}`;
  return `${minute} ${hour} * * *`;
}

function formatTime(time: string): string {
  const [rawHour = '9', rawMinute = '0'] = time.split(':');
  const hour = clamp(Number.parseInt(rawHour, 10), 0, 23);
  const minute = clamp(Number.parseInt(rawMinute, 10), 0, 59);
  const displayHour = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
  return `${displayHour}:${padTimePart(minute)} ${hour < 12 ? 'AM' : 'PM'}`;
}

function describeSimpleSchedule(schedule: SimpleSchedule, timezone: string): string {
  const time = formatTime(schedule.time);
  const tz = timezone.replaceAll('_', ' ');
  if (schedule.preset === 'weekdays') return `Weekdays at ${time} (${tz})`;
  if (schedule.preset === 'weekly') {
    const weekday = WEEKDAY_OPTIONS.find((option) => option.value === schedule.weekday)?.label;
    return `${weekday ?? 'Monday'} at ${time} (${tz})`;
  }
  return `Daily at ${time} (${tz})`;
}

/**
 * The cron-trigger form for the automation step. Skip / Create trigger buttons
 * live in the wizard footer, so this panel always shows its fields.
 */
export function StepAutomation({
  triggerForm,
  error,
  onChange,
}: Readonly<{
  triggerForm: TriggerForm;
  error: string | null;
  onChange: (next: TriggerForm) => void;
}>) {
  const schedule = parseSimpleSchedule(triggerForm.cronExpression);
  const updateSchedule = (next: Partial<SimpleSchedule>) => {
    const updated = { ...schedule, ...next };
    onChange({
      ...triggerForm,
      cronExpression: buildCronExpression(updated),
    });
  };

  return (
    <div className="grid gap-4">
      <StepHeader
        id="automation"
        title="Schedule automation (optional)"
        lead="A scheduled trigger runs a task agent with a prompt you define — a morning triage, weekly cleanup, or recurring dependency check. Skip it now and add triggers later from the project page."
      />
      <section className="grid gap-3 rounded-md border border-border-default bg-surface p-4">
        <label htmlFor="project-onboarding-trigger-name" className="grid gap-1.5">
          <span className="text-sm text-fg-muted">Name</span>
          <Input
            id="project-onboarding-trigger-name"
            value={triggerForm.name}
            onChange={(event) => onChange({ ...triggerForm, name: event.currentTarget.value })}
          />
        </label>

        <fieldset className="grid gap-3">
          <legend className="text-sm text-fg-muted">Schedule</legend>
          <div
            role="radiogroup"
            aria-label="Schedule frequency"
            className="grid gap-2 sm:grid-cols-3"
          >
            {SCHEDULE_PRESETS.map((preset) => {
              const selected = schedule.preset === preset.id;
              return (
                <button
                  key={preset.id}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => updateSchedule({ preset: preset.id })}
                  className={`grid min-h-20 gap-1 rounded-md border px-3 py-2.5 text-left transition-colors ${FOCUS_RING} ${
                    selected
                      ? 'border-accent bg-accent/10 text-fg-primary'
                      : 'border-border-default bg-inset/70 text-fg-muted hover:bg-surface-hover hover:text-fg-primary'
                  }`}
                >
                  <span className="flex items-center justify-between gap-2 text-sm font-semibold">
                    {preset.title}
                    <span
                      className={`flex size-5 shrink-0 items-center justify-center rounded-full border ${
                        selected
                          ? 'border-accent bg-accent text-fg-on-accent'
                          : 'border-border-default text-transparent'
                      }`}
                      aria-hidden="true"
                    >
                      <Check size={12} />
                    </span>
                  </span>
                  <span className="text-xs text-fg-muted">{preset.description}</span>
                </button>
              );
            })}
          </div>

          <div
            className={`grid gap-3 ${schedule.preset === 'weekly' ? 'md:grid-cols-3' : 'md:grid-cols-2'}`}
          >
            <label htmlFor="project-onboarding-schedule-time" className="grid gap-1.5">
              <span className="text-sm text-fg-muted">Time</span>
              <Input
                id="project-onboarding-schedule-time"
                type="time"
                value={schedule.time}
                onChange={(event) => updateSchedule({ time: event.currentTarget.value })}
              />
            </label>
            {schedule.preset === 'weekly' && (
              <label htmlFor="project-onboarding-schedule-day" className="grid gap-1.5">
                <span className="text-sm text-fg-muted">Day</span>
                <Select
                  id="project-onboarding-schedule-day"
                  value={String(schedule.weekday)}
                  onChange={(event) =>
                    updateSchedule({ weekday: Number.parseInt(event.currentTarget.value, 10) })
                  }
                >
                  {WEEKDAY_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </Select>
              </label>
            )}
            <label htmlFor="project-onboarding-schedule-timezone" className="grid gap-1.5">
              <span className="text-sm text-fg-muted">Timezone</span>
              <Select
                id="project-onboarding-schedule-timezone"
                value={triggerForm.cronTimezone}
                onChange={(event) =>
                  onChange({ ...triggerForm, cronTimezone: event.currentTarget.value })
                }
              >
                {COMMON_TIMEZONES.map((timezone) => (
                  <option key={timezone} value={timezone}>
                    {timezone.replaceAll('_', ' ')}
                  </option>
                ))}
              </Select>
            </label>
          </div>
          <p className="m-0 text-xs text-fg-muted">
            {describeSimpleSchedule(schedule, triggerForm.cronTimezone)}. Need a custom cron
            expression or more trigger controls? Open the trigger editor after onboarding.
          </p>
        </fieldset>

        <label htmlFor="project-onboarding-trigger-prompt" className="grid gap-1.5">
          <span className="text-sm text-fg-muted">Prompt</span>
          <textarea
            id="project-onboarding-trigger-prompt"
            value={triggerForm.promptTemplate}
            onChange={(event) =>
              onChange({ ...triggerForm, promptTemplate: event.currentTarget.value })
            }
            rows={4}
            placeholder="Review open dependency updates and open a PR for any safe bumps."
            className="w-full resize-y rounded-md bg-inset px-3 py-2 text-sm text-fg-primary"
          />
        </label>

        {error && <Alert variant="error">{error}</Alert>}
      </section>
      <WhyDetails question="How do I make the schedule more specific?">
        <p>
          Onboarding only covers the common schedules. Each run dispatches a task agent with the
          prompt above through the same pipeline a manual task uses. After the project is created,
          open the trigger editor to use custom cron expressions, change concurrency, or attach a
          different profile.
        </p>
      </WhyDetails>
    </div>
  );
}
