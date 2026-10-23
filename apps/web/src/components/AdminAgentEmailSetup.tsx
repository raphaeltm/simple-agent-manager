/**
 * Turns agent email on (preview). Shows what the setup would do now — including any records
 * Cloudflare adds to the main domain, which need the admin's consent first — and runs it.
 * `AdminAgentEmailPanel` renders this only while agent email is off. See
 * `apps/api/src/services/agent-email/setup.ts` for the server side.
 */
import type { AgentEmailMainDomainRecord, AgentEmailSetupPlan } from '@simple-agent-manager/shared';
import { Alert, Button, Spinner } from '@simple-agent-manager/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { useQueryScope } from '../hooks/useQueryScope';
import { runAgentEmailSetup } from '../lib/api/agent-email';
import {
  adminAgentEmailSetupQueryOptions,
  agentEmailQueryKeys,
} from '../lib/query-options/agent-email';

function recordContent(record: AgentEmailMainDomainRecord): string {
  return record.content ?? 'a DKIM key Cloudflare generates';
}

interface Props {
  /** Called once the setup reports agent email on. */
  onTurnedOn: (domain: string | null) => void;
}

export function AdminAgentEmailSetup({ onTurnedOn }: Props) {
  const scope = useQueryScope();
  const queryClient = useQueryClient();
  const query = useQuery(adminAgentEmailSetupQueryOptions(scope, true));
  const [allowMainDomainChanges, setAllowMainDomainChanges] = useState(false);
  const [pending, setPending] = useState<AgentEmailSetupPlan | null>(null);
  const setup = useMutation({
    mutationFn: (allow: boolean) => runAgentEmailSetup(allow),
    onSuccess: async (result) => {
      if (result.state === 'on') {
        setPending(null);
        // The public config is HTTP-cached; write it so this admin can add an email
        // automation right away.
        queryClient.setQueryData(agentEmailQueryKeys.config(scope), {
          enabled: true,
          domain: result.domain,
        });
        onTurnedOn(result.domain);
        await queryClient.invalidateQueries({ queryKey: agentEmailQueryKeys.adminStatus(scope) });
        return;
      }
      setPending(result);
      await queryClient.invalidateQueries({ queryKey: agentEmailQueryKeys.setupPlan(scope) });
    },
    onError: async () => {
      await queryClient.invalidateQueries({ queryKey: agentEmailQueryKeys.setupPlan(scope) });
    },
  });

  const plan = query.data;
  const failure = setup.error ?? (plan ? null : query.error);
  const error =
    failure instanceof Error ? failure.message : failure ? 'Could not check agent email' : null;
  const canRun = plan?.state === 'ready' || plan?.state === 'needs_consent';
  const needsConsent = plan?.state === 'needs_consent';
  const busy = setup.isPending || query.isFetching;

  return (
    <div className="space-y-3 min-w-0" data-testid="agent-email-setup">
      {error && <Alert variant="error">{error}</Alert>}
      {pending?.reason && <Alert variant="info">{pending.reason}</Alert>}
      {!plan ? (
        query.isError ? (
          <Button variant="secondary" disabled={busy} onClick={() => void query.refetch()}>
            {query.isFetching ? 'Checking…' : 'Check again'}
          </Button>
        ) : (
          !error && <Spinner />
        )
      ) : (
        <>
          {plan.state === 'refused' ? (
            <Alert variant="warning">{plan.reason}</Alert>
          ) : plan.state === 'ready' ? (
            <p className="text-sm text-fg-secondary break-words">
              Turning it on sets up Email Routing for{' '}
              <span className="font-mono">{plan.domain}</span> and sends its mail to this
              deployment. Nothing changes on <span className="font-mono">{plan.mainDomain}</span>.
            </p>
          ) : plan.state === 'on' ? (
            <p className="text-sm text-fg-secondary">Agent email is on.</p>
          ) : (
            plan.reason && <p className="text-sm text-fg-secondary break-words">{plan.reason}</p>
          )}
          {needsConsent && (
            <div className="space-y-2 rounded-md border border-border-default p-3 min-w-0">
              <p className="text-sm font-medium text-fg-primary">Cloudflare adds these records:</p>
              <ul className="space-y-1" data-testid="agent-email-main-domain-changes">
                {plan.mainDomainChanges.map((record) => (
                  <li key={`${record.type}:${record.name}`} className="text-xs text-fg-muted">
                    <span className="font-mono break-all text-fg-primary">
                      {record.type} {record.name}
                    </span>{' '}
                    — <span className="break-all">{recordContent(record)}</span>
                  </li>
                ))}
              </ul>
              <label className="flex items-start gap-2.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={allowMainDomainChanges}
                  disabled={setup.isPending}
                  onChange={(event) => setAllowMainDomainChanges(event.target.checked)}
                  className="mt-0.5 h-4 w-4 shrink-0 rounded border-border-default accent-accent-primary"
                />
                <span className="text-sm text-fg-secondary break-words">
                  Allow Cloudflare to add these records to {plan.mainDomain}
                </span>
              </label>
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            {canRun && (
              <Button
                disabled={busy || (needsConsent && !allowMainDomainChanges)}
                onClick={() => setup.mutate(needsConsent && allowMainDomainChanges)}
              >
                {setup.isPending ? 'Turning on…' : 'Turn on agent email'}
              </Button>
            )}
            {(plan.state === 'verifying' || plan.state === 'unavailable') && (
              <Button variant="secondary" disabled={busy} onClick={() => void query.refetch()}>
                {query.isFetching ? 'Checking…' : 'Check again'}
              </Button>
            )}
            {plan.state === 'on' && (
              <Button
                variant="secondary"
                onClick={() =>
                  void queryClient.invalidateQueries({
                    queryKey: agentEmailQueryKeys.adminStatus(scope),
                  })
                }
              >
                Refresh status
              </Button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
