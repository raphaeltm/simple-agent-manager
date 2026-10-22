import { FOCUS_RING } from './trigger-form-support';

interface EmailTriggerFieldsProps {
  /** One sender per line (or comma-separated); see {@link import('./trigger-form-support').splitEmailList}. */
  allowedSenders: string;
  onAllowedSendersChange: (value: string) => void;
  /** Validation message for the list, announced with the field. */
  error?: string;
}

const HINT_ID = 'email-allowed-senders-hint';
const ERROR_ID = 'email-allowed-senders-error';

/** Who may start an email automation. The address itself is shown on the automation's own page. */
export function EmailTriggerFields({
  allowedSenders,
  onAllowedSendersChange,
  error,
}: EmailTriggerFieldsProps) {
  return (
    <div>
      <label
        htmlFor="email-allowed-senders"
        className="block text-sm font-medium text-fg-primary mb-1"
      >
        Allowed senders
      </label>
      <textarea
        id="email-allowed-senders"
        rows={4}
        value={allowedSenders}
        onChange={(event) => onAllowedSendersChange(event.target.value)}
        placeholder="you@example.com"
        spellCheck={false}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${ERROR_ID} ${HINT_ID}` : HINT_ID}
        className={`w-full px-3 py-2 rounded-md text-fg-primary text-sm font-mono ${FOCUS_RING}`}
      />
      <p id={HINT_ID} className="text-xs text-fg-muted mt-1 mb-0">
        One address per line. Mail whose From address is on this list starts this automation, and
        the agent can reply to it. From addresses are not verified yet, so keep the automation&rsquo;s
        address private.
      </p>
      {error && (
        <p id={ERROR_ID} role="alert" className="mt-2 mb-0 text-[13px] font-medium text-danger-fg">
          {error}
        </p>
      )}
    </div>
  );
}
