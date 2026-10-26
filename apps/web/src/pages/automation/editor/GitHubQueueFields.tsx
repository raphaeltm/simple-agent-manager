import { FOCUS_RING } from '../../../components/triggers/trigger-form-support';
import { INPUT_CLASS } from '../fields';
import type { GitHubState } from './state';

export function GitHubQueueFields({
  value,
  onChange,
}: {
  value: GitHubState;
  onChange: (patch: Partial<GitHubState>) => void;
}) {
  return (
    <fieldset className="m-0 flex min-w-0 flex-col gap-3 rounded-xl border border-border-default p-4">
      <legend className="px-1 text-sm font-semibold text-fg-primary">When events overlap</legend>
      <label className="flex min-h-11 cursor-pointer items-start gap-3 text-sm text-fg-primary">
        <input
          type="checkbox"
          className="mt-1 shrink-0"
          checked={value.subjectAffinity}
          onChange={(event) => onChange({ subjectAffinity: event.target.checked })}
        />
        <span>
          Keep issue and PR follow-ups in one chat
          <span className="mt-1 block text-xs text-fg-muted">
            Events for the same issue or PR reach its existing chat. Sleeping chats wake to receive
            them.
          </span>
        </span>
      </label>
      <p className="m-0 text-xs text-fg-muted">
        Other events wait when the automation is busy. Events exceeding these limits are recorded as
        dropped or unconfirmed.
      </p>
      <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="flex min-w-0 flex-col gap-1 text-sm text-fg-primary">
          Pending event limit
          <input
            type="number"
            min="1"
            step="1"
            inputMode="numeric"
            value={value.queueMaxPending}
            onChange={(event) => onChange({ queueMaxPending: event.target.value })}
            className={`${INPUT_CLASS} ${FOCUS_RING}`}
          />
        </label>
        <label className="flex min-w-0 flex-col gap-1 text-sm text-fg-primary">
          Maximum wait (seconds)
          <input
            type="number"
            min="1"
            step="1"
            inputMode="numeric"
            value={value.queueTtlSeconds}
            onChange={(event) => onChange({ queueTtlSeconds: event.target.value })}
            className={`${INPUT_CLASS} ${FOCUS_RING}`}
          />
        </label>
      </div>
    </fieldset>
  );
}
