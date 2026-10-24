/**
 * "Addresses": grouped by the part of the app they reach.
 * A custom domain leads; the address SAM made sits under it as "also at". A domain that is
 * not working yet shows the exact DNS record to add and a "Check again" button, in place.
 */
import { Button } from '@simple-agent-manager/ui';
import { Plus, RefreshCw } from 'lucide-react';

import { CopyButton, Panel, SectionTitle } from '../../../components/page-kit/ui';
import type {
  DeploymentCustomDomain,
  DeploymentEnvironment,
  DeploymentPublicRoute,
} from '../../../lib/api';
import { useEnvironmentActions } from '../data';
import { domainState } from '../domains';
import { AddressLine, TonePill, TwoStepRemove } from '../shared';

function DomainRow({
  projectId,
  env,
  domain,
  answering,
}: {
  projectId: string;
  env: DeploymentEnvironment;
  domain: DeploymentCustomDomain;
  answering: boolean;
}) {
  const actions = useEnvironmentActions(projectId, env.id);
  const state = domainState(domain);
  const needsDns = state.label === 'Waiting for DNS' || state.label === 'Points elsewhere';
  return (
    <div className="flex flex-col">
      <span className="flex flex-wrap items-center gap-x-2">
        <AddressLine hostname={domain.hostname} answering={answering && state.tone === 'success'} />
        {state.tone !== 'success' && <TonePill tone={state.tone} label={state.label} />}
        <span className="ml-auto">
          <TwoStepRemove
            label={`Remove ${domain.hostname}`}
            confirm="Remove domain"
            busy={actions.removeDomain.isPending}
            onConfirm={() => actions.removeDomain.mutate(domain.id)}
          />
        </span>
      </span>
      {needsDns && domain.cnameTarget && (
        <div className="mb-2 flex flex-col gap-2 rounded-lg bg-inset px-3 py-2">
          <span className="text-[13px] text-fg-muted">
            Add a <strong className="text-fg-primary">CNAME</strong> record for {domain.hostname}{' '}
            pointing to:
          </span>
          <span className="flex min-w-0 items-center gap-1">
            <code className="min-w-0 break-all font-mono text-[13px] text-fg-primary">
              {domain.cnameTarget}
            </code>
            <CopyButton quiet label="DNS target" value={domain.cnameTarget} />
          </span>
          <Button
            variant="secondary"
            className="self-start"
            loading={actions.verifyDomain.isPending}
            onClick={() => actions.verifyDomain.mutate(domain.id)}
          >
            <RefreshCw size={15} aria-hidden /> Check again
          </Button>
          {domain.verificationError && (
            <span className="text-[13px] text-fg-muted [overflow-wrap:anywhere]">
              Last check: {domain.verificationError}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

export function Addresses({
  projectId,
  env,
  answering,
  routes,
  domains,
  onAddDomain,
}: {
  projectId: string;
  env: DeploymentEnvironment;
  answering: boolean;
  routes: DeploymentPublicRoute[];
  domains: DeploymentCustomDomain[];
  onAddDomain: () => void;
}) {
  const reaches = (domain: DeploymentCustomDomain, route: DeploymentPublicRoute) =>
    domain.service === route.service && domain.port === route.port;
  const orphans = domains.filter((domain) => !routes.some((route) => reaches(domain, route)));
  const paused = env.status === 'stopped';
  return (
    <section id="addresses" className="flex scroll-mt-4 flex-col gap-3" aria-label="Addresses">
      <SectionTitle
        title="Addresses"
        hint={
          paused
            ? 'Kept while paused. They answer again when you start the app.'
            : 'Where people reach this app.'
        }
        action={
          routes.length > 0 ? (
            <Button variant="secondary" onClick={onAddDomain} className="shrink-0">
              <Plus size={16} aria-hidden /> Your domain
            </Button>
          ) : undefined
        }
      />
      <Panel className="overflow-hidden">
        <ul className="m-0 list-none p-0">
          {routes.map((route) => {
            const own = domains.filter((domain) => reaches(domain, route));
            return (
              <li
                key={route.id}
                className="flex flex-col border-0 border-b border-solid border-border-default px-4 py-3 last:border-b-0"
              >
                <span className="text-[12px] font-semibold uppercase tracking-wide text-fg-muted">
                  {route.service}
                </span>
                {own.map((domain) => (
                  <DomainRow
                    key={domain.id}
                    projectId={projectId}
                    env={env}
                    domain={domain}
                    answering={answering}
                  />
                ))}
                {own.length > 0 ? (
                  <span className="flex min-w-0 items-center gap-1 text-[13px] text-fg-muted">
                    <span className="shrink-0">also at</span>
                    <AddressLine hostname={route.hostname} size="sm" answering={answering} />
                  </span>
                ) : (
                  <AddressLine hostname={route.hostname} answering={answering} />
                )}
              </li>
            );
          })}
          {orphans.map((domain) => (
            <li
              key={domain.id}
              className="flex flex-col border-0 border-b border-solid border-border-default px-4 py-3 last:border-b-0"
            >
              <span className="text-[12px] font-semibold uppercase tracking-wide text-fg-muted">
                {domain.service} (no longer in the app)
              </span>
              <DomainRow projectId={projectId} env={env} domain={domain} answering={false} />
            </li>
          ))}
        </ul>
        {routes.length === 0 && domains.length === 0 && (
          <p className="m-0 px-4 py-5 text-sm text-fg-muted">
            No addresses yet. The first deploy creates one for each part of the app that serves web
            traffic.
          </p>
        )}
      </Panel>
    </section>
  );
}
