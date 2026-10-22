import { FOCUS_RING } from './trigger-form-support';

interface EmailTriggerFieldsProps {
  /** One sender per line (or comma-separated); see {@link import('./trigger-form-support').splitEmailList}. */
  allowedSenders: string;
  onAllowedSendersChange: (value: string) => void;
}

/** Who may start an email automation. The address itself is shown on the automation's own page. */
export function EmailTriggerFields({
  allowedSenders,
  onAllowedSendersChange,
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
        className={`w-full px-3 py-2 rounded-md text-fg-primary text-sm font-mono ${FOCUS_RING}`}
      />
      <p className="text-xs text-fg-muted mt-1 mb-0">
        One address per line. Only mail from these senders starts this automation, and the agent
        can reply to them by email.
      </p>
    </div>
  );
}
