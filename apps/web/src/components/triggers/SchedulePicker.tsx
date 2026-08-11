import { ChevronDown } from 'lucide-react';
import type { FC } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';

import {
  buildCron,
  type DailyVariant,
  DEFAULT_CRON_EXPRESSION,
  describeCron,
  parseCronToMode,
  type ScheduleMode,
} from './schedule-cron';
import { FOCUS_RING } from './trigger-presentation';

interface SchedulePickerProps {
  value: string;
  onChange: (cron: string) => void;
  onDescriptionChange?: (description: string) => void;
  timezone: string;
  onTimezoneChange: (tz: string) => void;
}

const COMMON_TIMEZONES = [
  'UTC',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Sao_Paulo',
  'Europe/London',
  'Europe/Paris',
  'Europe/Berlin',
  'Africa/Lagos',
  'Africa/Johannesburg',
  'Asia/Dubai',
  'Asia/Kolkata',
  'Asia/Shanghai',
  'Asia/Tokyo',
  'Australia/Sydney',
  'Pacific/Auckland',
];

const DAYS_OF_WEEK = [
  { short: 'Mo', label: 'Monday', cron: 1 },
  { short: 'Tu', label: 'Tuesday', cron: 2 },
  { short: 'We', label: 'Wednesday', cron: 3 },
  { short: 'Th', label: 'Thursday', cron: 4 },
  { short: 'Fr', label: 'Friday', cron: 5 },
  { short: 'Sa', label: 'Saturday', cron: 6 },
  { short: 'Su', label: 'Sunday', cron: 0 },
];

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
  const initial = parseCronToMode(value);

  const [mode, setMode] = useState<ScheduleMode>(initial.mode);
  const [hour, setHour] = useState(initial.hour);
  const [minute, setMinute] = useState(initial.minute);
  const [everyNHours, setEveryNHours] = useState(initial.everyNHours);
  const [dailyVariant, setDailyVariant] = useState<DailyVariant>(initial.dailyVariant);
  const [weeklyDays, setWeeklyDays] = useState<number[]>(initial.weeklyDays);
  const [monthDay, setMonthDay] = useState(initial.monthDay);
  const [advancedCron, setAdvancedCron] = useState(value || DEFAULT_CRON_EXPRESSION);

  /*
   * Re-sync when `value` changes from OUTSIDE this component.
   *
   * These fields used to be seeded from `value` once at mount and never
   * reconciled. `TriggerForm` renders while its reset effect has not run yet,
   * so opening the edit drawer mounted the picker against the *previous*
   * cron — a trigger that runs at 02:30 displayed "Daily at 9:00 AM", and
   * touching any control emitted that fabricated schedule back, silently
   * rescheduling the user's trigger.
   *
   * We must distinguish an external change from the echo of our own
   * `onChange`, otherwise resyncing would fight the user mid-edit (notably in
   * the Advanced field). `lastEmittedRef` records what we last sent up;
   * anything else arriving is external and wins.
   *
   * Setting state during render is React's sanctioned way to adjust state when
   * a prop changes — it re-renders immediately without committing the stale UI.
   */
  const lastEmittedRef = useRef<string | null>(null);
  const [syncedValue, setSyncedValue] = useState(value);

  if (value !== syncedValue) {
    setSyncedValue(value);
    if (value !== lastEmittedRef.current) {
      const next = parseCronToMode(value);
      setMode(next.mode);
      setHour(next.hour);
      setMinute(next.minute);
      setEveryNHours(next.everyNHours);
      setDailyVariant(next.dailyVariant);
      setWeeklyDays(next.weeklyDays);
      setMonthDay(next.monthDay);
      setAdvancedCron(value || DEFAULT_CRON_EXPRESSION);
    }
  }

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
      lastEmittedRef.current = cron;
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
            className={`px-2 py-1.5 rounded-md text-fg-primary text-sm ${FOCUS_RING}`}
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
            className={`w-16 px-2 py-1.5 rounded-md text-fg-primary text-sm ${FOCUS_RING}`}
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
              className={`px-2 py-1.5 rounded-md text-fg-primary text-sm ${FOCUS_RING}`}
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
                      ? 'bg-accent text-fg-on-accent border-accent'
                      : 'bg-[color-mix(in_srgb,var(--sam-glass-nested-bg)_80%,transparent)] text-fg-muted border-[var(--sam-form-border)] hover:border-fg-muted'
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
            className={`w-16 px-2 py-1.5 rounded-md text-fg-primary text-sm ${FOCUS_RING}`}
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
            className={`w-full px-3 py-2 rounded-md text-fg-primary text-sm font-mono ${FOCUS_RING}`}
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
            className={`w-full appearance-none px-3 py-1.5 pr-8 rounded-md text-fg-primary text-sm ${FOCUS_RING}`}
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
      className={`w-14 px-2 py-1.5 rounded-md text-fg-primary text-sm text-center ${FOCUS_RING}`}
      aria-label="Hour"
    />
    <span className="text-fg-muted font-bold">:</span>
    <input
      type="number"
      min={0}
      max={59}
      value={minute}
      onChange={(e) => onMinuteChange(Math.min(59, Math.max(0, parseInt(e.target.value, 10) || 0)))}
      className={`w-14 px-2 py-1.5 rounded-md text-fg-primary text-sm text-center ${FOCUS_RING}`}
      aria-label="Minute"
    />
  </div>
);
