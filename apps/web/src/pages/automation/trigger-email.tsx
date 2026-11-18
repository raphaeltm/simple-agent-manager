/**
 * An email automation's page: its address with a copy button, and the senders allowed to use it.
 * The address works like a password, but people who can see the automation need it to share it
 * with its senders, so it stays visible here; it is not a once-only secret like the webhook token
 * in `trigger-webhook.tsx`. The allowed-senders list is what decides who can start it.
 */
import type { TriggerResponse } from '@simple-agent-manager/shared';

import { CopyButton, Panel, SectionTitle } from './ui';

export function ConnectEmail({ trigger }: { trigger: TriggerResponse }) {
  const config = trigger.emailConfig;
  const address = config?.address ?? null;
  return (
    <div className="flex flex-col gap-2">
      <SectionTitle title="Its email address" hint="Keep it private, like a password" />
      <Panel className="flex flex-col gap-4 p-4 md:p-5" label="Email address">
        <div className="flex flex-col gap-1.5">
          <span className="text-[13px] text-fg-muted">Address</span>
          {address ? (
            <div className="flex items-center gap-2">
              <code
                className="min-w-0 flex-1 break-all rounded-md bg-inset px-3 py-2.5 text-[13px] text-fg-primary"
                data-testid="email-trigger-address"
              >
                {address}
              </code>
              <CopyButton label="email address" value={address} />
            </div>
          ) : (
            <span className="text-[14px] text-fg-muted">Not available.</span>
          )}
          <span className="text-[13px] text-fg-muted">
            Anyone who has this address can email the agent, and SAM cannot yet verify who really
            sent an email. Share it only with the people listed below.
          </span>
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-[13px] text-fg-muted">Allowed senders</span>
          {config?.allowedSenders.length ? (
            <ul
              className="m-0 flex list-none flex-col gap-1 p-0"
              data-testid="email-allowed-senders"
            >
              {config.allowedSenders.map((sender) => (
                <li
                  key={sender}
                  className="break-all text-[14px] text-fg-primary [overflow-wrap:anywhere]"
                >
                  {sender}
                </li>
              ))}
            </ul>
          ) : (
            <span className="text-[14px] text-fg-muted">No senders allowed yet.</span>
          )}
          <span className="text-[13px] text-fg-muted">
            Mail whose From address is on this list starts the automation, and the agent can reply
            to it. Edit this automation to change the list.
          </span>
        </div>
      </Panel>
    </div>
  );
}
