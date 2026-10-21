/**
 * "What should it wait for?" for a standing watch: the events SAM can actually match, then the
 * limits that keep a busy event source from starting unbounded work.
 */
import {
  DEFAULT_PROJECT_EVENT_WATCH_COOLDOWN_MIN_MS,
  DEFAULT_PROJECT_EVENT_WATCH_MAX_CONCURRENT,
  DEFAULT_PROJECT_EVENT_WATCH_MAX_EXECUTIONS,
  PROJECT_EVENT_SEVERITIES,
} from '@simple-agent-manager/shared';

import { ChoiceCards, Field, INPUT_CLASS } from '../fields';
import { Disclosure } from '../ui';
import { WATCH_PRESETS, type WatchPreset, type WatchState } from './state';

const CHOICES: Array<{ id: WatchPreset; title: string; text?: string }> = [
  ...Object.entries(WATCH_PRESETS).map(([id, preset]) => ({
    id: id as WatchPreset,
    title: preset.label,
  })),
  {
    id: 'channel-post',
    title: 'An agent posts on a channel',
    text: 'A named channel agents publish to',
  },
  { id: 'custom', title: 'Something else', text: 'Match event fields yourself' },
];

const CUSTOM_FIELDS = [
  { key: 'source', label: 'Source', placeholder: 'github, sam.lifecycle' },
  { key: 'eventType', label: 'Event type', placeholder: 'issues.opened' },
  { key: 'subjectType', label: 'Subject type', placeholder: 'pull_request' },
  { key: 'subjectId', label: 'Subject', placeholder: '2387' },
] as const;

export function WatchWhen({
  value,
  onChange,
  errors,
}: {
  value: WatchState;
  onChange: (value: WatchState) => void;
  errors: { watch?: string; limits?: string };
}) {
  const set = (patch: Partial<WatchState>) => onChange({ ...value, ...patch });
  const minCooldown = DEFAULT_PROJECT_EVENT_WATCH_COOLDOWN_MIN_MS / 60_000;
  return (
    <div className="flex flex-col gap-6">
      <ChoiceCards
        label="What should it wait for?"
        value={value.preset}
        onChange={(preset) => set({ preset })}
        options={CHOICES}
      />
      {value.preset === 'channel-post' && (
        <Field
          label="Channel"
          error={errors.watch}
          hint="Its exact name, like release-train. Channels are listed under Behind the scenes."
        >
          {({ id, describedBy, invalid }) => (
            <input
              id={id}
              type="text"
              value={value.channel}
              aria-describedby={describedBy}
              aria-invalid={invalid}
              onChange={(event) => set({ channel: event.target.value })}
            />
          )}
        </Field>
      )}
      {value.preset === 'custom' && (
        <div className="flex flex-col gap-4">
          <p className="m-0 text-[13px] text-fg-muted">
            Every field you fill in must match. Separate several values with commas to match any of
            them. Empty fields match anything.
          </p>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {CUSTOM_FIELDS.map((field) => (
              <Field key={field.key} label={field.label} optional>
                {({ id }) => (
                  <input
                    id={id}
                    type="text"
                    className="font-mono"
                    spellCheck={false}
                    placeholder={field.placeholder}
                    value={value[field.key]}
                    onChange={(event) => set({ [field.key]: event.target.value })}
                  />
                )}
              </Field>
            ))}
          </div>
          <Field label="Severity" optional>
            {({ id, describedBy }) => (
              <select
                id={id}
                value={value.severity}
                aria-describedby={describedBy}
                onChange={(event) => set({ severity: event.target.value })}
              >
                <option value="">Any severity</option>
                {value.severity.includes(',') && (
                  <option value={value.severity}>{value.severity}</option>
                )}
                {PROJECT_EVENT_SEVERITIES.map((severity) => (
                  <option key={severity} value={severity}>
                    {severity}
                  </option>
                ))}
              </select>
            )}
          </Field>
          {errors.watch && (
            <p role="alert" className="m-0 text-[13px] font-medium text-danger-fg">
              {errors.watch}
            </p>
          )}
        </div>
      )}
      <Disclosure
        title="Limits"
        hint={`Up to ${value.maxConcurrent} at once · ${value.cooldownMinutes} min apart · ${value.maxExecutions} runs in total`}
        defaultOpen={Boolean(errors.limits)}
      >
        <p className="m-0 text-[13px] text-fg-muted">
          Each matching event starts a chat, so limits keep a busy source from starting too much
          work. You can raise the total later.
        </p>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Field label="Wait between runs (minutes)">
            {({ id }) => (
              <input
                id={id}
                type="number"
                inputMode="numeric"
                min={minCooldown}
                className={INPUT_CLASS}
                value={Number.isFinite(value.cooldownMinutes) ? value.cooldownMinutes : ''}
                onChange={(event) => set({ cooldownMinutes: event.target.valueAsNumber })}
              />
            )}
          </Field>
          <Field label="Most at once">
            {({ id }) => (
              <input
                id={id}
                type="number"
                inputMode="numeric"
                min={1}
                max={DEFAULT_PROJECT_EVENT_WATCH_MAX_CONCURRENT}
                className={INPUT_CLASS}
                value={Number.isFinite(value.maxConcurrent) ? value.maxConcurrent : ''}
                onChange={(event) => set({ maxConcurrent: event.target.valueAsNumber })}
              />
            )}
          </Field>
          <Field label="Runs in total">
            {({ id }) => (
              <input
                id={id}
                type="number"
                inputMode="numeric"
                min={1}
                max={DEFAULT_PROJECT_EVENT_WATCH_MAX_EXECUTIONS}
                className={INPUT_CLASS}
                value={Number.isFinite(value.maxExecutions) ? value.maxExecutions : ''}
                onChange={(event) => set({ maxExecutions: event.target.valueAsNumber })}
              />
            )}
          </Field>
        </div>
        {errors.limits && (
          <p role="alert" className="m-0 text-[13px] font-medium text-danger-fg">
            {errors.limits}
          </p>
        )}
      </Disclosure>
    </div>
  );
}
