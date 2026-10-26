import { CheckRow, Field, INPUT_CLASS } from '../fields';
import type { Errors } from './requests';
import type { GitHubState } from './state';

export function GitHubQueueFields({
  value,
  onChange,
  errors,
}: {
  value: GitHubState;
  onChange: (patch: Partial<GitHubState>) => void;
  errors: Errors;
}) {
  return (
    <fieldset className="m-0 flex min-w-0 flex-col gap-3 rounded-xl border border-border-default p-4">
      <legend className="px-1 text-sm font-semibold text-fg-primary">
        When GitHub events overlap
      </legend>
      {value.eventType !== 'push' && (
        <CheckRow
          checked={value.subjectAffinity}
          onChange={(subjectAffinity) => onChange({ subjectAffinity })}
          label="Keep issue and PR follow-ups in one chat"
          hint="Follow-up events reach this automation’s active chat for the same issue or PR. Sleeping chats wake to receive them."
        />
      )}
      <p className="m-0 text-[13px] text-fg-muted">
        When busy, keep events within these limits. Events beyond the limit or wait time appear in
        History with a reason.
      </p>
      <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Pending event limit" error={errors.queueMaxPending}>
          {({ id, describedBy, invalid }) => (
            <input
              id={id}
              type="number"
              min="1"
              step="1"
              inputMode="numeric"
              value={value.queueMaxPending}
              onChange={(event) => onChange({ queueMaxPending: event.target.value })}
              aria-describedby={describedBy}
              aria-invalid={invalid}
              className={INPUT_CLASS}
            />
          )}
        </Field>
        <Field
          label="Maximum wait (hours)"
          hint="Fractions of an hour are allowed, down to one second."
          error={errors.queueTtlHours}
        >
          {({ id, describedBy, invalid }) => (
            <input
              id={id}
              type="number"
              min="0"
              step="any"
              inputMode="decimal"
              value={value.queueTtlHours}
              onChange={(event) => onChange({ queueTtlHours: event.target.value })}
              aria-describedby={describedBy}
              aria-invalid={invalid}
              className={INPUT_CLASS}
            />
          )}
        </Field>
      </div>
    </fieldset>
  );
}
