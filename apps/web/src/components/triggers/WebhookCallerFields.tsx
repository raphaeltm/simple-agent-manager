/**
 * "Who is calling?" for a webhook automation: my own script (SAM's token), Slack, or another
 * service that signs its requests. The choice sets the verification scheme, which is fixed once
 * the automation exists, so the editor shows it read-only when editing.
 */
import type { WebhookCaller, WebhookState } from '../../pages/automation/editor/state';
import { ChoiceCards, Field, INPUT_CLASS } from '../../pages/automation/fields';

const CALLERS: Array<{ id: WebhookCaller; title: string; text: string }> = [
  {
    id: 'slack',
    title: 'Slack',
    text: 'Mentions and other Slack events. Verified with your Slack app’s signing secret.',
  },
  {
    id: 'signed',
    title: 'Another service that signs its requests',
    text: 'GitHub repository webhooks and others that send an HMAC-SHA256 of the body.',
  },
  {
    id: 'script',
    title: 'My own script or service',
    text: 'Your code sends a secret token that SAM gives you.',
  },
];

const CALLER_NAMES: Record<WebhookCaller, string> = {
  slack: 'Slack (signing secret)',
  signed: 'A service that signs its requests (HMAC-SHA256)',
  script: 'My own script or service (SAM token)',
};

export function WebhookCallerFields({
  value,
  creating,
  errors,
  onCallerChange,
  onChange,
}: {
  value: WebhookState;
  /** False when editing: the caller cannot change, only where its event ID is. */
  creating: boolean;
  errors: { signature?: string; eventId?: string };
  onCallerChange: (caller: WebhookCaller) => void;
  onChange: (patch: Partial<WebhookState>) => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      {creating ? (
        <ChoiceCards
          label="Who is calling?"
          value={value.caller}
          onChange={onCallerChange}
          columns={1}
          options={CALLERS}
        />
      ) : (
        <p className="m-0 text-sm text-fg-muted" data-testid="webhook-caller-fixed">
          Called by: <span className="text-fg-primary">{CALLER_NAMES[value.caller]}</span>. This
          cannot be changed after creation.
        </p>
      )}

      {value.caller === 'signed' && (
        <>
          {creating && (
            <Field
              label="Signature header"
              hint="The header where the service puts the HMAC-SHA256 of the request body. GitHub uses x-hub-signature-256."
              error={errors.signature}
            >
              {({ id, describedBy, invalid }) => (
                <input
                  id={id}
                  type="text"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  className={`${INPUT_CLASS} font-mono`}
                  placeholder="x-hub-signature-256"
                  value={value.signatureHeader}
                  aria-describedby={describedBy}
                  aria-invalid={invalid}
                  onChange={(event) => onChange({ signatureHeader: event.target.value })}
                />
              )}
            </Field>
          )}
          <Field
            label="Where is the event ID?"
            hint={
              value.eventIdSource === 'header'
                ? 'Each event needs its own ID so a retry does not start a second run. GitHub sends it in the x-github-delivery header. A header is not covered by the signature, so an event with exactly the same body as an earlier one is also treated as a repeat.'
                : 'Each event needs its own ID so a retry does not start a second run. Use a dot path into the JSON body, such as event.id.'
            }
            error={errors.eventId}
          >
            {({ id, describedBy, invalid }) => (
              <div className="flex flex-col gap-2 sm:flex-row">
                <select
                  aria-label="Event ID location"
                  className={`${INPUT_CLASS} sm:!w-44`}
                  value={value.eventIdSource}
                  onChange={(event) => {
                    const eventIdSource = event.target.value === 'path' ? 'path' : 'header';
                    // A header name is not a body path and vice versa: a key kept across the
                    // switch would pass validation and then never find the ID.
                    if (eventIdSource !== value.eventIdSource)
                      onChange({ eventIdSource, eventIdKey: '' });
                  }}
                >
                  <option value="header">In a header</option>
                  <option value="path">In the body</option>
                </select>
                <input
                  id={id}
                  type="text"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  className={`${INPUT_CLASS} font-mono`}
                  placeholder={value.eventIdSource === 'path' ? 'event.id' : 'x-github-delivery'}
                  value={value.eventIdKey}
                  aria-describedby={describedBy}
                  aria-invalid={invalid}
                  onChange={(event) => onChange({ eventIdKey: event.target.value })}
                />
              </div>
            )}
          </Field>
        </>
      )}
    </div>
  );
}
