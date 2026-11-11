/**
 * Connecting a signed webhook automation (Slack, or a service that signs its requests): the
 * address to give the sender, the write-only signing secret, short steps, and one status line
 * that says where setup stands and why calls are being refused.
 */
import {
  type TriggerResponse,
  WEBHOOK_SIGNING_SECRET_ANCHOR,
  type WebhookSetupStatus,
} from '@simple-agent-manager/shared';
import { Button } from '@simple-agent-manager/ui';
import { type FormEvent, useEffect, useId, useRef, useState } from 'react';

import { setWebhookSigningSecret } from '../../lib/api';
import { formatTimeFromNow } from '../../lib/time-utils';
import { useProjectContext } from '../ProjectContext';
import { webhookRejectionPhrase } from './describe';
import { useAutomationAction } from './detail-parts';
import { errorText } from './errors';
import { INPUT_CLASS } from './fields';
import { CopyButton, OutcomeIcon, Panel, SectionTitle } from './ui';

type StatusTone = 'ok' | 'waiting' | 'failed';

/** One line: what to do next, or that it works, or why it does not. */
export function setupStatusLine(
  setup: WebhookSetupStatus | undefined,
  canWrite: boolean,
  now = Date.now()
): { tone: StatusTone; text: string; detail?: string } {
  if (!setup || setup.state === 'needs_secret')
    return canWrite
      ? { tone: 'waiting', text: 'Paste the signing secret to continue' }
      : { tone: 'waiting', text: 'Waiting for someone who can edit to save the signing secret' };
  if (setup.state === 'waiting_for_first_request')
    return { tone: 'waiting', text: 'Waiting for the first request' };
  if (setup.state === 'rejecting') {
    const rejection = setup.lastRejection;
    const when = rejection ? formatTimeFromNow(Date.parse(rejection.at), now) : null;
    return {
      tone: 'failed',
      text: `Requests are being refused: ${webhookRejectionPhrase(rejection?.reason ?? '')}`,
      detail: [when ? `Last refused ${when}.` : null, rejection?.hint].filter(Boolean).join(' '),
    };
  }
  const last = setup.lastEventAt ? formatTimeFromNow(Date.parse(setup.lastEventAt), now) : null;
  const waiting = setup.waiting > 0 ? ` · ${setup.waiting} waiting for a free run` : '';
  return { tone: 'ok', text: `Receiving${last ? ` · last event ${last}` : ''}${waiting}` };
}

function SlackSteps() {
  return (
    <ol className="m-0 flex list-decimal flex-col gap-1.5 pl-5 text-[13px] text-fg-muted">
      <li>
        Create a Slack app.
        {/* On its own line: a full-height touch target that overlaps no other step. */}
        <a
          href="https://api.slack.com/apps"
          target="_blank"
          rel="noreferrer"
          className="flex min-h-11 w-fit items-center font-mono text-[12.5px] text-fg-primary underline underline-offset-2"
        >
          Open api.slack.com/apps
          <span className="sr-only"> (opens in a new tab)</span>
        </a>
      </li>
      <li>Copy its Signing Secret (Basic Information, App Credentials) and save it here.</li>
      <li>
        In Event Subscriptions, paste the address above as the Request URL and subscribe to the bot
        event <span className="font-mono text-[12.5px]">app_mention</span>. Slack checks the address
        straight away.
      </li>
      <li>
        Install the app, invite it to a channel and mention it. To reply in Slack, the agent needs
        its own Slack connection or bot token.
      </li>
    </ol>
  );
}

function GenericSteps({ header, eventId }: { header: string; eventId: string }) {
  return (
    <ol className="m-0 flex list-decimal flex-col gap-1.5 pl-5 text-[13px] text-fg-muted">
      <li>Save the secret the service signs its requests with here.</li>
      <li>Give the service the address above. It must send JSON.</li>
      <li>
        SAM checks the HMAC-SHA256 of the body in the{' '}
        <span className="break-all font-mono text-[12.5px]">{header}</span> header and reads each
        event’s ID from <span className="break-all font-mono text-[12.5px]">{eventId}</span>.
      </li>
    </ol>
  );
}

function SigningSecretField({
  trigger,
  secretSet,
  setAt,
  focusOnMount,
}: {
  trigger: TriggerResponse;
  secretSet: boolean;
  setAt: string | null;
  focusOnMount: boolean;
}) {
  const { projectId } = useProjectContext();
  const [value, setValue] = useState('');
  const [replacing, setReplacing] = useState(false);
  // True from a successful save until the refreshed automation reports the secret itself, so
  // the empty field does not flash back in between.
  const [justSaved, setJustSaved] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const savedRow = useRef<HTMLDivElement>(null);
  // Where focus goes after the field and the saved line swap places.
  const focusNext = useRef<'input' | 'replace' | null>(focusOnMount ? 'input' : null);
  const inputId = useId();
  const helpId = useId();
  const errorId = useId();
  const save = useAutomationAction(
    (secret: string) => setWebhookSigningSecret(projectId, trigger.id, secret),
    {
      success: 'Signing secret saved. SAM will not show it again.',
      failure: 'Could not save the signing secret',
    },
    () => {
      // The value leaves the page as soon as it is saved.
      setValue('');
      setReplacing(false);
      setJustSaved(true);
      focusNext.current = 'replace';
    }
  );
  const editing = replacing || !(secretSet || justSaved);
  useEffect(() => {
    // Keyboard and screen-reader users stay where the action was: Replace opens onto the
    // field, Cancel and Save return to the Replace button.
    const target = focusNext.current;
    if (target === 'input' && editing) input.current?.focus({ preventScroll: true });
    else if (target === 'replace' && !editing)
      savedRow.current?.querySelector('button')?.focus({ preventScroll: true });
    else return;
    focusNext.current = null;
  }, [editing]);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (value.trim()) save.mutate(value.trim());
  };
  if (!editing) {
    return (
      <div ref={savedRow} className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="w-full text-[13px] text-fg-muted">Signing secret</span>
        <span className="text-[15px] text-fg-primary" data-testid="signing-secret-saved">
          Saved{setAt ? ` ${formatTimeFromNow(Date.parse(setAt))}` : ''} · hidden
        </span>
        <Button
          variant="ghost"
          onClick={() => {
            focusNext.current = 'input';
            save.reset();
            setReplacing(true);
          }}
        >
          Replace secret
        </Button>
      </div>
    );
  }
  return (
    <form className="flex flex-col gap-2" onSubmit={submit}>
      <label htmlFor={inputId} className="text-[13px] text-fg-muted">
        Signing secret
      </label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          ref={input}
          id={inputId}
          type="password"
          name="webhook-signing-secret"
          // A sender's signing secret is not this site's password: keep password managers from
          // offering to fill or save it.
          autoComplete="new-password"
          data-1p-ignore
          data-lpignore="true"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          className={`${INPUT_CLASS} font-mono`}
          placeholder="Paste the signing secret"
          value={value}
          aria-describedby={save.isError ? `${errorId} ${helpId}` : helpId}
          aria-invalid={save.isError || undefined}
          onChange={(event) => {
            setValue(event.target.value);
            if (save.isError) save.reset();
          }}
        />
        <div className="flex gap-2">
          <Button
            type="submit"
            className="flex-1 sm:flex-none"
            loading={save.isPending}
            disabled={!value.trim()}
          >
            Save secret
          </Button>
          {replacing && (
            <Button
              variant="ghost"
              className="flex-1 sm:flex-none"
              onClick={() => {
                focusNext.current = 'replace';
                save.reset();
                setValue('');
                setReplacing(false);
              }}
            >
              Cancel
            </Button>
          )}
        </div>
      </div>
      {save.isError && (
        <span id={errorId} role="alert" className="text-[13px] text-danger-fg">
          {errorText(save.error, 'Could not save the signing secret')}
        </span>
      )}
      <span id={helpId} className="text-[13px] text-fg-muted">
        {replacing
          ? 'Saving replaces the current secret right away. Calls signed with the old one are then refused.'
          : 'Stored encrypted and never shown again. Don’t paste it into an agent chat.'}
      </span>
    </form>
  );
}

/**
 * Which column the connection panel sits in for this visit. Until events arrive, finishing
 * the connection is the main thing on the page; once it works it belongs with the other
 * connection details. Decided once, from the first read that carries the setup state: a panel
 * that changed columns when the first event arrived would move out from under its user.
 */
export function useSignedSetupPlacement(
  trigger: TriggerResponse | undefined
): 'main' | 'side' | null {
  const setupState = trigger?.webhookConfig?.setup?.state;
  const [placement, setPlacement] = useState<{ triggerId: string; main: boolean } | null>(null);
  if (trigger && setupState && placement?.triggerId !== trigger.id) {
    setPlacement({ triggerId: trigger.id, main: setupState !== 'receiving' });
  }
  if (!trigger || placement?.triggerId !== trigger.id) return null;
  return placement.main ? 'main' : 'side';
}

export function ConnectSignedWebhook({
  trigger,
  canWrite,
}: {
  trigger: TriggerResponse;
  canWrite: boolean;
}) {
  const config = trigger.webhookConfig;
  const root = useRef<HTMLDivElement>(null);
  const openedOnSecretLink =
    typeof window !== 'undefined' && window.location.hash === `#${WEBHOOK_SIGNING_SECRET_ANCHOR}`;
  useEffect(() => {
    // The app scrolls inside its own wrapper, so a link's fragment does not scroll by itself.
    if (!openedOnSecretLink) return;
    root.current?.scrollIntoView({ block: 'start' });
    // Used once. Left in place, a refresh or a remount would pull the page back up here.
    window.history.replaceState(
      window.history.state,
      '',
      window.location.pathname + window.location.search
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (!config) return null;
  const slack = config.verification.scheme === 'slack_v0';
  const status = setupStatusLine(config.setup, canWrite);
  const receiving = config.setup?.state === 'receiving';
  const eventId = config.eventId
    ? 'path' in config.eventId
      ? `body path ${config.eventId.path}`
      : `the ${config.eventId.header} header`
    : 'a place that is not set';
  return (
    <div ref={root} id={WEBHOOK_SIGNING_SECRET_ANCHOR} className="flex scroll-mt-4 flex-col gap-2">
      <SectionTitle
        title={slack ? 'Connect Slack' : 'Connect your service'}
        hint={
          receiving
            ? 'Its address and signing secret'
            : slack
              ? undefined
              : 'Give the service this address and save its secret'
        }
      />
      <Panel className="flex flex-col gap-4 p-4 md:p-5" label="Webhook connection">
        <div
          className="flex items-start gap-2.5"
          role="status"
          data-testid="webhook-setup-status"
          data-state={config.setup?.state ?? 'needs_secret'}
        >
          <span className="pt-0.5">
            <OutcomeIcon outcome={status.tone} />
          </span>
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="text-[15px] font-semibold text-fg-primary [overflow-wrap:anywhere]">
              {status.text}
            </span>
            {status.detail && (
              <span className="text-[13px] text-fg-muted [overflow-wrap:anywhere]">
                {status.detail}
              </span>
            )}
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <span className="text-[13px] text-fg-muted">
            {slack ? 'Request URL for Slack' : 'Webhook URL'}
          </span>
          <div className="flex items-center gap-2">
            <code
              className="min-w-0 flex-1 break-all rounded-md bg-inset px-3 py-2.5 text-[13px] text-fg-primary"
              data-testid="webhook-url"
            >
              {config.endpointUrl}
            </code>
            <CopyButton label="webhook URL" value={config.endpointUrl} />
          </div>
        </div>

        {canWrite ? (
          <SigningSecretField
            trigger={trigger}
            secretSet={Boolean(config.signingSecret?.set)}
            setAt={config.signingSecret?.setAt ?? null}
            focusOnMount={openedOnSecretLink}
          />
        ) : (
          <div className="flex flex-col gap-1.5">
            <span className="text-[13px] text-fg-muted">Signing secret</span>
            <span className="text-[15px] text-fg-primary">
              {config.signingSecret?.set
                ? 'Saved · hidden'
                : 'Not saved yet. Someone who can edit this automation has to save it.'}
            </span>
          </div>
        )}

        {/* The steps are for getting connected; once events arrive they are only noise. */}
        {!receiving &&
          (slack ? (
            <SlackSteps />
          ) : (
            <GenericSteps
              header={
                config.verification.scheme === 'hmac_sha256_body' ? config.verification.header : ''
              }
              eventId={eventId}
            />
          ))}

        <span className="border-0 border-t border-solid border-border-default pt-3 text-[13px] text-fg-muted">
          {slack
            ? 'Anyone who can mention the app starts a run with this automation’s agent profile and its owner’s access. SAM passes their message to the agent as untrusted input.'
            : 'Anyone who can make the service send an event starts a run with this automation’s agent profile and its owner’s access. SAM passes the event to the agent as untrusted input.'}
        </span>
      </Panel>
    </div>
  );
}
