/**
 * Superadmin status, setup and loopback self-test for agent email (preview). Mirrors the shape
 * of `AdminConnectorPanel`: a status line, then the setup while agent email is off or the
 * self-test once it is on — all through TanStack Query so a background refresh never hides
 * what is already on screen (rule 48).
 */
import { Alert, Button, Input, Spinner } from '@simple-agent-manager/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { useQueryScope } from '../hooks/useQueryScope';
import { sendAgentEmailLoopback } from '../lib/api/agent-email';
import { adminAgentEmailQueryOptions, agentEmailQueryKeys } from '../lib/query-options/agent-email';
import { AdminAgentEmailSetup } from './AdminAgentEmailSetup';

function when(iso: string): string {
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? iso : parsed.toLocaleString();
}

export function AdminAgentEmailPanel() {
  const scope = useQueryScope();
  const queryClient = useQueryClient();
  const query = useQuery(adminAgentEmailQueryOptions(scope));
  const [to, setTo] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const loopback = useMutation({
    mutationFn: (address: string) => sendAgentEmailLoopback(address),
    onSuccess: async () => {
      setMessage(
        "Sent. The automation's agent usually replies within a few minutes; use Refresh to check for it."
      );
      await queryClient.invalidateQueries({ queryKey: agentEmailQueryKeys.adminStatus(scope) });
    },
  });
  const status = query.data;
  const failure = loopback.error ?? query.error;
  const error =
    failure instanceof Error ? failure.message : failure ? 'Could not reach agent email' : null;
  const domain = status?.domain ?? '…';

  return (
    <section
      className="space-y-5 border-t border-border-default pt-6 min-w-0"
      aria-label="Agent email"
    >
      <div>
        <h2 className="text-xl font-semibold">Agent email</h2>
        <p className="text-sm text-fg-muted">
          Lets automations receive and send email. A deploy prepares it; turn it on here, then
          send a self-test.
        </p>
      </div>
      {error && <Alert variant="error">{error}</Alert>}
      {message && <Alert variant="success">{message}</Alert>}
      {!status ? (
        !error && <Spinner />
      ) : (
        <>
          <p className="text-sm font-medium text-fg-primary" data-testid="agent-email-status">
            {status.enabled ? (
              <>
                On — <span className="font-mono">{status.domain}</span>
              </>
            ) : (
              'Off'
            )}
          </p>
          {!status.enabled && (
            <AdminAgentEmailSetup
              onTurnedOn={(turnedOn) =>
                setMessage(
                  `Agent email is on${turnedOn ? ` for ${turnedOn}` : ''}. Send a loopback test to check it end to end.`
                )
              }
            />
          )}
          {status.enabled && (
            <>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  setMessage(null);
                  if (to.trim()) loopback.mutate(to.trim());
                }}
                className="flex flex-col gap-3 sm:flex-row sm:items-end"
              >
                <div className="flex-1 min-w-0 space-y-1">
                  <label className="text-sm font-medium block" htmlFor="agent-email-loopback-to">
                    Send loopback test to
                  </label>
                  <Input
                    id="agent-email-loopback-to"
                    type="email"
                    placeholder={`agent+xxxxxxxxxxxxxxxx@${domain}`}
                    value={to}
                    disabled={loopback.isPending}
                    onChange={(event) => setTo(event.target.value)}
                  />
                </div>
                <Button type="submit" disabled={loopback.isPending || !to.trim()}>
                  {loopback.isPending ? 'Sending…' : 'Send loopback test'}
                </Button>
              </form>
              <p className="text-xs text-fg-muted break-words">
                Sends a fixed test email from{' '}
                <span className="font-mono">agent+loopback@{domain}</span> to an email automation.
                Add <span className="font-mono">agent+loopback@{domain}</span> to that
                automation&rsquo;s allowed senders first. When its agent replies, the reply shows up
                here.
              </p>
              <div className="flex justify-end">
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={query.isFetching}
                  onClick={() => void query.refetch()}
                >
                  {query.isFetching ? 'Refreshing…' : 'Refresh'}
                </Button>
              </div>
              <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="min-w-0 space-y-1">
                  <dt className="text-xs font-medium uppercase tracking-wider text-fg-muted">
                    Last sent
                  </dt>
                  <dd
                    className="m-0 text-sm text-fg-primary break-words"
                    data-testid="agent-email-last-sent"
                  >
                    {status.loopback.lastSent ? (
                      <>
                        {when(status.loopback.lastSent.sentAt)} to {status.loopback.lastSent.to}
                      </>
                    ) : (
                      'Not sent yet'
                    )}
                  </dd>
                </div>
                <div className="min-w-0 space-y-1">
                  <dt className="text-xs font-medium uppercase tracking-wider text-fg-muted">
                    Last reply received
                  </dt>
                  <dd
                    className="m-0 text-sm text-fg-primary break-words"
                    data-testid="agent-email-last-received"
                  >
                    {status.loopback.lastReceived ? (
                      <>
                        {when(status.loopback.lastReceived.receivedAt)} from{' '}
                        {status.loopback.lastReceived.from} — &ldquo;
                        {status.loopback.lastReceived.subject}&rdquo;
                        {status.loopback.lastReceived.autoSubmitted ? ' (Auto-Submitted)' : ''}
                      </>
                    ) : (
                      'None received yet'
                    )}
                  </dd>
                </div>
              </dl>
            </>
          )}
        </>
      )}
    </section>
  );
}
