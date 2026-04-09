/**
 * SchedulePicker — visual schedule builder with tab modes.
 * Converts between friendly UI and 5-field cron expressions.
 */
import { ChevronDown } from 'lucide-react';
import type { FC } from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ScheduleMode = 'hourly' | 'daily' | 'weekly' | 'monthly' | 'advanced';
type DailyVariant = 'every' | 'weekday' | 'weekend';

interface SchedulePickerProps {
  /** Current cron expression (source of truth). */
  value: string;
  /** Called when the schedule changes. */
  onChange: (cronExpression: string) => void;
  /** Called with human-readable description. */
  onDescriptionChange?: (description: string) => void;
  /** Current timezone. */
  timezone: string;
  /** Called when timezone changes. */
  onTimezoneChange: (tz: string) => void;
}

// ---------------------------------------------------------------------------
// Common timezones for quick selection
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FOCUS_RING =
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring';

const DAYS_OF_WEEK = [
  { short: 'M', label: 'Monday', cron: 1 },
  { short: 'T', label: 'Tuesday', cron: 2 },
  { short: 'W', label: 'Wednesday', cron: 3 },
  { short: 'T', label: 'Thursday', cron: 4 },
  { short: 'F', label: 'Friday', cron: 5 },
  { short: 'S', label: 'Saturday', cron: 6 },
  { short: 'S', label: 'Sunday', cron: 0 },
];

function parseCronToMode(cron: string): {
  mode: ScheduleMode;
  hour: number;
  minute: number;
  everyNHours: number;
  dailyVariant: DailyVariant;
  weeklyDays: number[];
  monthDay: number;
} {
  const defaults = {
    hour: 9,
    minute: 0,
    everyNHours: 1,
    dailyVariant: 'every' as DailyVariant,
    weeklyDays: [1],
    monthDay: 1,
  };

  if (!cron.trim()) return { mode: 'hourly', ...defaults };

  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return { mode: 'advanced', ...defaults };

  const [minStr, hourStr, domStr, , dowStr] = parts;

  const min = parseInt(minStr!, 10);
  const minute = isNaN(min) ? 0 : min;

  // Hourly: */N * * * * or 0 */N * * *
  if (hourStr!.startsWith('*/') && domStr === '*' && dowStr === '*') {
    const n = parseInt(hourStr!.slice(2), 10);
    return { mode: 'hourly', hour: 0, minute, everyNHours: isNaN(n) ? 1 : n, dailyVariant: 'every', weeklyDays: [1], monthDay: 1 };
  }

  const hour = parseInt(hourStr!, 10);
  if (isNaN(hour)) return { mode: 'advanced', ...defaults };

  // Monthly: M H D * *
  if (domStr !== '*' && dowStr === '*') {
    const dom = parseInt(domStr!, 10);
    return { mode: 'monthly', hour, minute, everyNHours: 1, dailyVariant: 'every', weeklyDays: [1], monthDay: isNaN(dom) ? 1 : dom };
  }

  // Weekly: M H * * 1,3,5
  if (domStr === '*' && dowStr !== '*') {
    const days = dowStr!.split(',').map(Number).filter((n) => !isNaN(n));
    // Check if weekday or weekend
    const isWeekday = days.length === 5 && [1, 2, 3, 4, 5].every((d) => days.includes(d));
    const isWeekend = days.length === 2 && [0, 6].every((d) => days.includes(d));

    if (isWeekday) return { mode: 'daily', hour, minute, everyNHours: 1, dailyVariant: 'weekday', weeklyDays: days, monthDay: 1 };
    if (isWeekend) return { mode: 'daily', hour, minute, everyNHours: 1, dailyVariant: 'weekend', weeklyDays: days, monthDay: 1 };

    return { mode: 'weekly', hour, minute, everyNHours: 1, dailyVariant: 'every', weeklyDays: days, monthDay: 1 };
  }

  // Daily: M H * * *
  if (domStr === '*' && dowStr === '*') {
    return { mode: 'daily', hour, minute, everyNHours: 1, dailyVariant: 'every', weeklyDays: [1], monthDay: 1 };
  }

  return { mode: 'advanced', ...defaults };
}

function buildCron(
  mode: ScheduleMode,
  hour: number,
  minute: number,
  everyNHours: number,
  dailyVariant: DailyVariant,
  weeklyDays: number[],
  monthDay: number,
  advancedCron: string,
): string {
  switch (mode) {
    case 'hourly':
      return `${minute} */${everyNHours} * * *`;
    case 'daily':
      if (dailyVariant === 'weekday') return `${minute} ${hour} * * 1,2,3,4,5`;
      if (dailyVariant === 'weekend') return `${minute} ${hour} * * 0,6`;
      return `${minute} ${hour} * * *`;
    case 'weekly':
      return `${minute} ${hour} * * ${weeklyDays.sort((a, b) => a - b).join(',')}`;
    case 'monthly':
      return `${minute} ${hour} ${monthDay} * *`;
    case 'advanced':
      return advancedCron;
  }
}

function describeCron(cron: string): string {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return 'Invalid expression';

  try {
    const [minStr, hourStr, domStr, , dowStr] = parts;
    const min = parseInt(minStr!, 10);

    if (hourStr!.startsWith('*/')) {
      const n = parseInt(hourStr!.slice(2), 10);
      return `Every ${n} hour(s) at minute ${min}`;
    }

    const hour = parseInt(hourStr!, 10);
    if (isNaN(hour)) return cron;

    const timeStr = `${hour === 0 ? 12 : hour > 12 ? hour - 12 : hour}:${String(min).padStart(2, '0')} ${hour < 12 ? 'AM' : 'PM'}`;

    if (domStr !== '*' && dowStr === '*') {
      return `Monthly on day ${domStr} at ${timeStr}`;
    }

    if (dowStr !== '*' && domStr === '*') {
      const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      const days = dowStr!.split(',').map(Number);
      const isWeekday = days.length === 5 && [1, 2, 3, 4, 5].every((d) => days.includes(d));
      const isWeekend = days.length === 2 && [0, 6].every((d) => days.includes(d));
      if (isWeekday) return `Weekdays at ${timeStr}`;
      if (isWeekend) return `Weekends at ${timeStr}`;
      return `${days.map((d) => dayNames[d]).join(', ')} at ${timeStr}`;
    }

    if (domStr === '*' && dowStr === '*') {
      return `Daily at ${timeStr}`;
    }

    return cron;
  } catch {
    return cron;
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const TAB_MODES: { mode: ScheduleMode; label: string }[] = [
  { mode: 'hourly', label: 'Hourly' },
  { mode: 'daily', label: 'Daily' },
  { mode: 'weekly', label: 'Weekly' },
  { mode: 'monthly', label: 'Monthly' },
  { mode: 'advanced', label: 'Advanced' },
];

export const SchedulePicker: FC<SchedulePickerProps> = ({
  value,
  onChange,
  onDescriptionChange,
  timezone,
  onTimezoneChange,
}) => {
  const parsed = useMemo(() => parseCronToMode(value), [value]);

  const [mode, setMode] = useState<ScheduleMode>(parsed.mode);
  const [hour, setHour] = useState(parsed.hour);
  const [minute, setMinute] = useState(parsed.minute);
  const [everyNHours, setEveryNHours] = useState(parsed.everyNHours);
  const [dailyVariant, setDailyVariant] = useState<DailyVariant>(parsed.dailyVariant);
  const [weeklyDays, setWeeklyDays] = useState<number[]>(parsed.weeklyDays);
  const [monthDay, setMonthDay] = useState(parsed.monthDay);
  const [advancedCron, setAdvancedCron] = useState(value || '0 9 * * *');

  const emitChange = useCallback(
    (
      m: ScheduleMode,
      h: number,
      min: number,
      nh: number,
      dv: DailyVariant,
      wd: number[],
      md: number,
      ac: string,
    ) => {
      const cron = buildCron(m, h, min, nh, dv, wd, md, ac);
      onChange(cron);
      onDescriptionChange?.(describeCron(cron));
    },
    [onChange, onDescriptionChange],
  );

  // Emit on initial render
  useEffect(() => {
    const cron = buildCron(mode, hour, minute, everyNHours, dailyVariant, weeklyDays, monthDay, advancedCron);
    onDescriptionChange?.(describeCron(cron));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleModeChange(newMode: ScheduleMode) {
    setMode(newMode);
    if (newMode === 'advanced') {
      const current = buildCron(mode, hour, minute, everyNHours, dailyVariant, weeklyDays, monthDay, advancedCron);
      setAdvancedCron(current);
      emitChange(newMode, hour, minute, everyNHours, dailyVariant, weeklyDays, monthDay, current);
    } else {
      emitChange(newMode, hour, minute, everyNHours, dailyVariant, weeklyDays, monthDay, advancedCron);
    }
  }

  return (
    <div className="space-y-4">
      {/* Mode tabs */}
      <div className="flex flex-wrap gap-1 p-1 bg-surface-hover rounded-md" role="tablist">
        {TAB_MODES.map(({ mode: m, label }) => (
          <button
            key={m}
            role="tab"
            aria-selected={mode === m}
            onClick={() => handleModeChange(m)}
            className={`px-3 py-1.5 text-xs font-medium rounded-md cursor-pointer border-none transition-colors ${FOCUS_RING} ${
              mode === m
                ? 'bg-surface text-fg-primary shadow-sm'
                : 'bg-transparent text-fg-muted hover:text-fg-primary'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Mode-specific controls */}
      {mode === 'hourly' && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-fg-muted">Run every</span>
          <select
            value={everyNHours}
            onChange={(e) => {
              const n = parseInt(e.target.value, 10);
              setEveryNHours(n);
              emitChange(mode, hour, minute, n, dailyVariant, weeklyDays, monthDay, advancedCron);
            }}
            className={`px-2 py-1.5 rounded-md border border-border-default bg-surface text-fg-primary text-sm ${FOCUS_RING}`}
          >
            {[1, 2, 3, 4, 6, 8, 12].map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
          <span className="text-fg-muted">hour(s), starting at minute</span>
          <input
            type="number"
            min={0}
            max={59}
            value={minute}
            onChange={(e) => {
              const m = Math.min(59, Math.max(0, parseInt(e.target.value, 10) || 0));
              setMinute(m);
              emitChange(mode, hour, m, everyNHours, dailyVariant, weeklyDays, monthDay, advancedCron);
            }}
            className={`w-16 px-2 py-1.5 rounded-md border border-border-default bg-surface text-fg-primary text-sm ${FOCUS_RING}`}
          />
        </div>
      )}

      {mode === 'daily' && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-fg-muted">Run every</span>
            <select
              value={dailyVariant}
              onChange={(e) => {
                const dv = e.target.value as DailyVariant;
                setDailyVariant(dv);
                emitChange(mode, hour, minute, everyNHours, dv, weeklyDays, monthDay, advancedCron);
              }}
              className={`px-2 py-1.5 rounded-md border border-border-default bg-surface text-fg-primary text-sm ${FOCUS_RING}`}
            >
              <option value="every">day</option>
              <option value="weekday">weekday</option>
              <option value="weekend">weekend</option>
            </select>
            <span className="text-fg-muted">at</span>
            <TimeInput
              hour={hour}
              minute={minute}
              onHourChange={(h) => { setHour(h); emitChange(mode, h, minute, everyNHours, dailyVariant, weeklyDays, monthDay, advancedCron); }}
              onMinuteChange={(m) => { setMinute(m); emitChange(mode, hour, m, everyNHours, dailyVariant, weeklyDays, monthDay, advancedCron); }}
            />
          </div>
        </div>
      )}

      {mode === 'weekly' && (
        <div className="space-y-3">
          <div className="flex flex-wrap gap-1.5">
            {DAYS_OF_WEEK.map((day, idx) => {
              const selected = weeklyDays.includes(day.cron);
              return (
                <button
                  key={`${day.cron}-${idx}`}
                  onClick={() => {
                    const next = selected
                      ? weeklyDays.filter((d) => d !== day.cron)
                      : [...weeklyDays, day.cron];
                    const days = next.length > 0 ? next : [day.cron];
                    setWeeklyDays(days);
                    emitChange(mode, hour, minute, everyNHours, dailyVariant, days, monthDay, advancedCron);
                  }}
                  aria-pressed={selected}
                  aria-label={day.label}
                  className={`w-9 h-9 rounded-md text-xs font-medium border cursor-pointer transition-colors ${FOCUS_RING} ${
                    selected
                      ? 'bg-accent text-white border-accent'
                      : 'bg-surface text-fg-muted border-border-default hover:border-fg-muted'
                  }`}
                >
                  {day.short}
                </button>
              );
            })}
          </div>
          <div className="flex items-center gap-2 text-sm">
            <span className="text-fg-muted">at</span>
            <TimeInput
              hour={hour}
              minute={minute}
              onHourChange={(h) => { setHour(h); emitChange(mode, h, minute, everyNHours, dailyVariant, weeklyDays, monthDay, advancedCron); }}
              onMinuteChange={(m) => { setMinute(m); emitChange(mode, hour, m, everyNHours, dailyVariant, weeklyDays, monthDay, advancedCron); }}
            />
          </div>
        </div>
      )}

      {mode === 'monthly' && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-fg-muted">Run on day</span>
          <input
            type="number"
            min={1}
            max={28}
            value={monthDay}
            onChange={(e) => {
              const d = Math.min(28, Math.max(1, parseInt(e.target.value, 10) || 1));
              setMonthDay(d);
              emitChange(mode, hour, minute, everyNHours, dailyVariant, weeklyDays, d, advancedCron);
            }}
            className={`w-16 px-2 py-1.5 rounded-md border border-border-default bg-surface text-fg-primary text-sm ${FOCUS_RING}`}
          />
          <span className="text-fg-muted">of every month at</span>
          <TimeInput
            hour={hour}
            minute={minute}
            onHourChange={(h) => { setHour(h); emitChange(mode, h, minute, everyNHours, dailyVariant, weeklyDays, monthDay, advancedCron); }}
            onMinuteChange={(m) => { setMinute(m); emitChange(mode, hour, m, everyNHours, dailyVariant, weeklyDays, monthDay, advancedCron); }}
          />
        </div>
      )}

      {mode === 'advanced' && (
        <div className="space-y-2">
          <input
            type="text"
            value={advancedCron}
            onChange={(e) => {
              setAdvancedCron(e.target.value);
              emitChange(mode, hour, minute, everyNHours, dailyVariant, weeklyDays, monthDay, e.target.value);
            }}
            placeholder="0 9 * * 1-5"
            className={`w-full px-3 py-2 rounded-md border border-border-default bg-surface text-fg-primary text-sm font-mono ${FOCUS_RING}`}
            aria-label="Cron expression"
          />
          <p className="text-xs text-fg-muted m-0">
            Format: minute hour day-of-month month day-of-week — {describeCron(advancedCron)}
          </p>
        </div>
      )}

      {/* Timezone selector */}
      <div className="flex items-center gap-2 text-sm">
        <span className="text-fg-muted shrink-0">Timezone:</span>
        <div className="relative flex-1 max-w-xs">
          <select
            value={timezone}
            onChange={(e) => onTimezoneChange(e.target.value)}
            className={`w-full appearance-none px-3 py-1.5 pr-8 rounded-md border border-border-default bg-surface text-fg-primary text-sm ${FOCUS_RING}`}
            aria-label="Timezone"
          >
            {COMMON_TIMEZONES.map((tz) => (
              <option key={tz} value={tz}>{tz.replace(/_/g, ' ')}</option>
            ))}
          </select>
          <ChevronDown
            size={14}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-fg-muted pointer-events-none"
            aria-hidden="true"
          />
        </div>
      </div>

      {/* Human-readable description */}
      {mode !== 'advanced' && (
        <p className="text-xs text-fg-muted m-0 italic">
          {describeCron(buildCron(mode, hour, minute, everyNHours, dailyVariant, weeklyDays, monthDay, advancedCron))}
          {timezone !== 'UTC' && ` (${timezone.replace(/_/g, ' ')})`}
        </p>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Time input sub-component
// ---------------------------------------------------------------------------

const TimeInput: FC<{
  hour: number;
  minute: number;
  onHourChange: (h: number) => void;
  onMinuteChange: (m: number) => void;
}> = ({ hour, minute, onHourChange, onMinuteChange }) => (
  <div className="flex items-center gap-1">
    <input
      type="number"
      min={0}
      max={23}
      value={hour}
      onChange={(e) => onHourChange(Math.min(23, Math.max(0, parseInt(e.target.value, 10) || 0)))}
      className={`w-14 px-2 py-1.5 rounded-md border border-border-default bg-surface text-fg-primary text-sm text-center ${FOCUS_RING}`}
      aria-label="Hour"
    />
    <span className="text-fg-muted font-bold">:</span>
    <input
      type="number"
      min={0}
      max={59}
      value={minute}
      onChange={(e) => onMinuteChange(Math.min(59, Math.max(0, parseInt(e.target.value, 10) || 0)))}
      className={`w-14 px-2 py-1.5 rounded-md border border-border-default bg-surface text-fg-primary text-sm text-center ${FOCUS_RING}`}
      aria-label="Minute"
    />
  </div>
);
