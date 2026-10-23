/**
 * Turns agent email on (preview). Shows what the setup would do now, including any change
 * outside the agent email subdomain, which needs the admin's consent first, and runs it.
 * Consent is bound to the plan shown: the server runs only with that plan's `consentToken`.
 * `AdminAgentEmailPanel` renders this only while agent email is off. See
 * `apps/api/src/services/agent-email/setup.ts` for the server side.
 */
import type { AgentEmailMainDomainRecord, AgentEmailSetupPlan } from '@simple-agent-manager/shared';
import { Alert, Button, Spinner } from '@simple-agent-manager/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';

import { useQueryScope } from '../hooks/useQueryScope';
import { runAgentEmailSetup } from '../lib/api/agent-email';
import {
  adminAgentEmailSetupQueryOptions,
  agentEmailQueryKeys,
} from '../lib/query-options/agent-email';

/** States the admin leaves by changing something elsewhere, then checking again. */
const CHECK_AGAIN_STATES = new Set<AgentEmailSetupPlan['state']>([
  'unavailable',
  'verifying',
  'refused',
  'changed',
]);

function recordContent(record: AgentEmailMainDomainRecord): string {
  return record.content ?? 'a DKIM key Cloudflare generates';
}

function recordVerb(plan: AgentEmailSetupPlan, record: AgentEmailMainDomainRecord): string {
  if (plan.state === 'changed') return record.change === 'add' ? 'Added' : 'Removed';
  return record.change === 'add' ? 'Adds' : 'Removes';
}

interface Props {
  /** Called once the setup reports agent email on. */
  onTurnedOn: (domain: string | null) => void;
}

export function AdminAgentEmailSetup({ onTurnedOn }: Props) {
  const scope = useQueryScope();
  const queryClient = useQueryClient();
  const query = useQuery(adminAgentEmailSetupQueryOptions(scope, true));
  // The token the admin allowed. A refetched plan with other changes has another token, so
  // the box clears itself rather than carrying consent over to changes not yet read.
  const [allowedToken, setAllowedToken] = useState<string | null>(null);
  const consentLabelId = useId();
  const [pending, setPending] = useState<AgentEmailSetupPlan | null>(null);
  const setup = useMutation({
    mutationFn: (consentToken: string | null) => runAgentEmailSetup(consentToken),
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
  const canRun =
    plan?.state === 'ready' || plan?.state === 'needs_consent' || plan?.state === 'changed';
  const consentToken = plan?.consentToken ?? null;
  const allowed = consentToken !== null && allowedToken === consentToken;
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
          {plan.state === 'refused' || plan.state === 'changed' ? (
            <Alert variant="warning">{plan.reason}</Alert>
          ) : plan.state === 'unavailable' || plan.state === 'verifying' ? (
            // Blocked until something outside this panel changes: say so as a notice, not as
            // the neutral copy the ready state uses.
            plan.reason && <Alert variant="info">{plan.reason}</Alert>
          ) : plan.state === 'ready' ? (
            <p className="text-sm text-fg-secondary break-words">
              Turning it on sets up Email Routing for{' '}
              <span className="font-mono">{plan.domain}</span> and sends its mail to this
              deployment. Nothing changes on <span className="font-mono">{plan.mainDomain}</span> or
              in the zone&rsquo;s Email Routing settings.
            </p>
          ) : plan.state === 'on' ? (
            <p className="text-sm text-fg-secondary">Agent email is on.</p>
          ) : (
            plan.reason && <p className="text-sm text-fg-secondary break-words">{plan.reason}</p>
          )}
          {consentToken !== null && (
            <div className="space-y-2 rounded-md border border-border-default p-3 min-w-0">
              <p className="text-sm font-medium text-fg-primary">
                {plan.state === 'changed' ? 'What changed:' : 'Turning it on also changes:'}
              </p>
              <ul className="space-y-1" data-testid="agent-email-setup-changes">
                {plan.mainDomainChanges.map((record) => (
                  <li
                    key={`${record.change}:${record.type}:${record.name}:${record.content ?? ''}`}
                    className="text-xs text-fg-muted"
                  >
                    {recordVerb(plan, record)}{' '}
                    <span className="font-mono break-all text-fg-primary">
                      {record.type} {record.name}
                    </span>{' '}
                    — <span className="break-all">{recordContent(record)}</span>
                  </li>
                ))}
                {plan.zoneChanges.map((change) => (
                  <li key={change.setting} className="text-xs text-fg-muted break-words">
                    {change.description}
                  </li>
                ))}
              </ul>
              <label className="flex items-start gap-2.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={allowed}
                  disabled={setup.isPending}
                  onChange={(event) => setAllowedToken(event.target.checked ? consentToken : null)}
                  className="mt-0.5 h-4 w-4 shrink-0 rounded border-border-default accent-accent-primary"
                />
                <span id={consentLabelId} className="text-sm text-fg-secondary break-words">
                  {plan.state === 'changed'
                    ? `Turn agent email on with the records of ${plan.mainDomain} as they are now`
                    : 'Allow these changes'}
                </span>
              </label>
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            {canRun && (
              <Button
                disabled={busy || (consentToken !== null && !allowed)}
                aria-describedby={consentToken !== null ? consentLabelId : undefined}
                onClick={() => setup.mutate(allowed ? consentToken : null)}
              >
                {setup.isPending ? 'Turning on…' : 'Turn on agent email'}
              </Button>
            )}
            {CHECK_AGAIN_STATES.has(plan.state) && (
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
