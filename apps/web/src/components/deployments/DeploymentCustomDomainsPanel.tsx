import { Alert, Button, StatusBadge } from '@simple-agent-manager/ui';
import {
  Clipboard,
  ExternalLink,
  Globe2,
  Plus,
  RefreshCw,
  Route,
  Trash2,
  TriangleAlert,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { useToast } from '../../hooks/useToast';
import {
  createDeploymentCustomDomain,
  deleteDeploymentCustomDomain,
  type DeploymentCustomDomain,
  type DeploymentPublicRoute,
  listDeploymentCustomDomains,
  listDeploymentPublicRoutes,
  verifyDeploymentCustomDomain,
} from '../../lib/api';
import { formatDateTimeCompact } from './deployment-card-format';

interface Props {
  projectId: string;
  environmentId: string;
}

function routeLabel(route: Pick<DeploymentPublicRoute, 'service' | 'port'>): string {
  return `${route.service}:${route.port}`;
}

function routeKey(route: Pick<DeploymentPublicRoute, 'service' | 'port'>): string {
  return `${route.service}:${route.port}`;
}

function domainRouteKey(domain: Pick<DeploymentCustomDomain, 'service' | 'port'>) {
  return `${domain.service}:${domain.port}`;
}

function statusMeta(domain: DeploymentCustomDomain): {
  badge: string;
  label: string;
  tone: string;
  sentence: string;
} {
  if (domain.desiredState === 'deactivating' || domain.servingStatus === 'deactivating') {
    return {
      badge: 'stale',
      label: 'Deactivating',
      tone: 'text-warning',
      sentence: 'Deletion is requested. SAM is removing this hostname from the deployment node.',
    };
  }
  if (domain.servingStatus === 'active') {
    return {
      badge: 'connected',
      label: 'Active',
      tone: 'text-success',
      sentence: 'DNS is verified and the deployment node reports this route config active.',
    };
  }
  if (domain.servingStatus === 'inactive_environment_stopped') {
    return {
      badge: 'stale',
      label: 'Inactive',
      tone: 'text-fg-muted',
      sentence:
        'The domain is preserved, but this deployment environment is not currently serving routes.',
    };
  }
  if (domain.servingStatus === 'activating' || domain.routingStatus === 'activating') {
    return {
      badge: 'pending',
      label: 'Activating',
      tone: 'text-warning',
      sentence: 'DNS is verified. SAM is applying this hostname to Caddy on the deployment node.',
    };
  }
  if (domain.servingStatus === 'dns_recheck_required' || domain.routeTargetChanged) {
    return {
      badge: 'error',
      label: 'DNS recheck required',
      tone: 'text-danger',
      sentence:
        'The generated SAM route target changed. Re-check DNS before SAM serves this hostname.',
    };
  }
  if (domain.cnameTarget === null || domain.servingStatus === 'route_missing') {
    return {
      badge: 'error',
      label: 'Route missing',
      tone: 'text-danger',
      sentence: 'The parent public route is not present in the current release.',
    };
  }
  if (domain.verificationStatus === 'failed' || domain.servingStatus === 'dns_failed') {
    return {
      badge: 'error',
      label: 'DNS mismatch',
      tone: 'text-danger',
      sentence: 'Verification failed against the expected route target.',
    };
  }
  return {
    badge: 'pending',
    label: 'Pending DNS',
    tone: 'text-fg-muted',
    sentence: 'Waiting for DNS to resolve to the route target before activation.',
  };
}

function countDomainsForRoute(
  route: DeploymentPublicRoute,
  domains: DeploymentCustomDomain[]
): number {
  const key = routeKey(route);
  return domains.filter((domain) => domainRouteKey(domain) === key).length;
}

function matchesRoute(domain: DeploymentCustomDomain, route: DeploymentPublicRoute): boolean {
  return route.service === domain.service && route.port === domain.port;
}

export function DeploymentCustomDomainsPanel({ projectId, environmentId }: Props) {
  const toast = useToast();
  const [routes, setRoutes] = useState<DeploymentPublicRoute[]>([]);
  const [domains, setDomains] = useState<DeploymentCustomDomain[]>([]);
  const [selectedRouteId, setSelectedRouteId] = useState<string>('');
  const [hostname, setHostname] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [verifyingId, setVerifyingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading((current) => current);
    setError(null);
    try {
      const [routeResponse, domainResponse] = await Promise.all([
        listDeploymentPublicRoutes(projectId, environmentId),
        listDeploymentCustomDomains(projectId, environmentId),
      ]);
      setRoutes(routeResponse.publicRoutes);
      setDomains(domainResponse.customDomains);
      setSelectedRouteId((current) =>
        routeResponse.publicRoutes.some((route) => route.id === current)
          ? current
          : routeResponse.publicRoutes[0]?.id || ''
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load custom domains');
    } finally {
      setLoading(false);
    }
  }, [environmentId, projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  const selectedRoute = useMemo(
    () => routes.find((route) => route.id === selectedRouteId) ?? routes[0] ?? null,
    [routes, selectedRouteId]
  );
  const selectedDomains = useMemo(() => {
    if (!selectedRoute) return [];
    const key = routeKey(selectedRoute);
    return domains.filter((domain) => domainRouteKey(domain) === key);
  }, [domains, selectedRoute]);
  const missingRouteDomains = useMemo(
    () =>
      domains.filter(
        (domain) =>
          domain.cnameTarget === null && !routes.some((route) => matchesRoute(domain, route))
      ),
    [domains, routes]
  );
  const verifiedCount = domains.filter((domain) => domain.verificationStatus === 'verified').length;
  const attentionCount = domains.filter(
    (domain) =>
      domain.verificationStatus === 'failed' ||
      domain.cnameTarget === null ||
      domain.routeTargetChanged ||
      domain.desiredState === 'deactivating'
  ).length;
  const pendingCount = domains.filter((domain) => domain.verificationStatus === 'pending').length;

  const addDomain = async () => {
    if (!selectedRoute) return;
    const trimmedHostname = hostname.trim();
    if (!trimmedHostname) {
      setError('Hostname is required.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const created = await createDeploymentCustomDomain(projectId, environmentId, {
        service: selectedRoute.service,
        port: selectedRoute.port,
        hostname: trimmedHostname,
      });
      setDomains((current) => [...current, created]);
      setHostname('');
      toast.success('Custom domain added');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add custom domain');
    } finally {
      setSaving(false);
    }
  };

  const verifyDomain = async (domainId: string) => {
    setVerifyingId(domainId);
    setError(null);
    try {
      const updated = await verifyDeploymentCustomDomain(projectId, environmentId, domainId);
      setDomains((current) => current.map((domain) => (domain.id === domainId ? updated : domain)));
      toast.success(
        updated.verificationStatus === 'verified' ? 'DNS verified' : 'DNS verification failed'
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to verify custom domain');
    } finally {
      setVerifyingId(null);
    }
  };

  const deleteDomain = async (domain: DeploymentCustomDomain) => {
    if (!window.confirm(`Delete custom domain ${domain.hostname}?`)) return;
    setDeletingId(domain.id);
    setError(null);
    try {
      const updated = await deleteDeploymentCustomDomain(projectId, environmentId, domain.id);
      setDomains((current) =>
        updated.deletedAt || updated.desiredState === 'deleted'
          ? current.filter((item) => item.id !== domain.id)
          : current.map((item) => (item.id === domain.id ? updated : item))
      );
      toast.success(
        updated.desiredState === 'deactivating'
          ? 'Custom domain deactivation requested'
          : 'Custom domain deleted'
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete custom domain');
    } finally {
      setDeletingId(null);
    }
  };

  const copy = async (value: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value);
      toast.success(`${label} copied`);
    } catch {
      toast.error('Failed to copy to clipboard');
    }
  };

  if (loading) {
    return (
      <section className="rounded-md border border-border-default bg-inset px-3 py-3 text-sm text-fg-muted">
        Loading custom domains...
      </section>
    );
  }

  return (
    <section id={`deployment-domains-${environmentId}`} className="grid gap-4">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Metric label="Custom domains" value={String(domains.length)} />
        <Metric label="Verified" value={String(verifiedCount)} />
        <Metric label="Pending DNS" value={String(pendingCount)} />
        <Metric label="Attention" value={String(attentionCount)} tone="text-warning" />
      </div>

      <Alert variant="info">
        Custom domains attach to an existing public route. Add a DNS-only CNAME record, verify DNS,
        then SAM applies the hostname to the deployment node without requiring a new app release.
      </Alert>

      {error && (
        <Alert variant="error" onDismiss={() => setError(null)}>
          {error}
        </Alert>
      )}

      {routes.length === 0 && domains.length === 0 ? (
        <EmptyState
          title="No public routes"
          body="Submit a release with a public route before adding custom domains."
        />
      ) : (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
          <div className="grid gap-4">
            <RouteSelector
              routes={routes}
              domains={domains}
              selectedRouteId={selectedRoute?.id ?? ''}
              onSelect={setSelectedRouteId}
            />

            <section className="grid gap-3">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
                <div className="grid gap-1">
                  <h2 className="sam-type-section-heading m-0 text-fg-primary">Custom domains</h2>
                  <div className="text-xs text-fg-muted">
                    Showing {selectedDomains.length} for{' '}
                    {selectedRoute ? routeLabel(selectedRoute) : 'selected route'}
                  </div>
                </div>
                <Button size="sm" variant="secondary" onClick={() => void load()}>
                  <RefreshCw size={14} />
                  Refresh
                </Button>
              </div>

              {selectedDomains.length === 0 && selectedRoute ? (
                <EmptyState
                  title={`No domains on ${routeLabel(selectedRoute)}`}
                  body="Add one from the panel beside this route."
                />
              ) : (
                <div className="grid gap-2">
                  {selectedDomains.map((domain) => (
                    <DomainCard
                      key={domain.id}
                      domain={domain}
                      route={
                        routes.find(
                          (route) => route.service === domain.service && route.port === domain.port
                        ) ?? null
                      }
                      verifying={verifyingId === domain.id}
                      deleting={deletingId === domain.id}
                      onCopy={(value, label) => void copy(value, label)}
                      onVerify={() => void verifyDomain(domain.id)}
                      onDelete={() => void deleteDomain(domain)}
                    />
                  ))}
                </div>
              )}

              {missingRouteDomains.length > 0 && (
                <div className="grid gap-2">
                  <div className="flex items-center gap-2 text-xs font-semibold uppercase text-warning">
                    <TriangleAlert size={14} />
                    Domains with missing routes
                  </div>
                  {missingRouteDomains.map((domain) => (
                    <DomainCard
                      key={domain.id}
                      domain={domain}
                      route={null}
                      verifying={verifyingId === domain.id}
                      deleting={deletingId === domain.id}
                      onCopy={(value, label) => void copy(value, label)}
                      onVerify={() => void verifyDomain(domain.id)}
                      onDelete={() => void deleteDomain(domain)}
                    />
                  ))}
                </div>
              )}
            </section>
          </div>

          <aside className="grid content-start gap-4">
            {routes.length > 0 && (
              <AddDomainPanel
                routes={routes}
                selectedRoute={selectedRoute}
                selectedRouteId={selectedRoute?.id ?? ''}
                hostname={hostname}
                saving={saving}
                onRouteChange={setSelectedRouteId}
                onHostnameChange={setHostname}
                onSubmit={() => void addDomain()}
                onCopy={(value, label) => void copy(value, label)}
              />
            )}
            <DnsPolicyPanel />
          </aside>
        </div>
      )}
    </section>
  );
}

function Metric({
  label,
  value,
  tone = 'text-fg-primary',
}: {
  label: string;
  value: string;
  tone?: string;
}) {
  return (
    <div className="rounded-sm border border-border-default bg-inset px-3 py-2">
      <div className="text-[0.6875rem] font-semibold uppercase text-fg-muted">{label}</div>
      <div className={`text-xl font-semibold ${tone}`}>{value}</div>
    </div>
  );
}

function RouteSelector({
  routes,
  domains,
  selectedRouteId,
  onSelect,
}: {
  routes: DeploymentPublicRoute[];
  domains: DeploymentCustomDomain[];
  selectedRouteId: string;
  onSelect: (routeId: string) => void;
}) {
  return (
    <section className="grid gap-3">
      <div className="flex items-center gap-2 text-sm font-semibold text-fg-primary">
        <Route size={15} />
        Public routes
      </div>
      <div className="grid gap-2 lg:grid-cols-2">
        {routes.map((route) => {
          const selected = route.id === selectedRouteId;
          return (
            <button
              key={route.id}
              type="button"
              onClick={() => onSelect(route.id)}
              className={`grid gap-2 rounded-md border px-3 py-3 text-left transition-colors ${
                selected
                  ? 'border-accent bg-accent-tint'
                  : 'border-border-default bg-inset hover:border-fg-muted'
              }`}
            >
              <div className="flex min-w-0 items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold text-fg-primary">
                    {routeLabel(route)}
                  </div>
                  <div className="break-all text-xs text-fg-muted">{route.hostname}</div>
                </div>
                <StatusBadge status="connected" label="Published" />
              </div>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-muted">
                <span>host port {route.hostPort}</span>
                <span>route {route.routeIndex + 1}</span>
                <span>{countDomainsForRoute(route, domains)} domains</span>
              </div>
            </button>
          );
        })}
      </div>
    </section>
  );
}

function AddDomainPanel({
  routes,
  selectedRoute,
  selectedRouteId,
  hostname,
  saving,
  onRouteChange,
  onHostnameChange,
  onSubmit,
  onCopy,
}: {
  routes: DeploymentPublicRoute[];
  selectedRoute: DeploymentPublicRoute | null;
  selectedRouteId: string;
  hostname: string;
  saving: boolean;
  onRouteChange: (routeId: string) => void;
  onHostnameChange: (value: string) => void;
  onSubmit: () => void;
  onCopy: (value: string, label: string) => void;
}) {
  return (
    <section className="rounded-md border border-border-default bg-inset px-3 py-3">
      <form
        className="grid gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-sm font-semibold text-fg-primary">
            <Plus size={15} />
            Add domain
          </div>
          <StatusBadge status="pending" label="Creates pending" />
        </div>

        <label className="grid gap-1.5 text-xs text-fg-muted">
          <span className="font-semibold uppercase">Route</span>
          <select
            value={selectedRouteId}
            onChange={(event) => onRouteChange(event.currentTarget.value)}
            className="block w-full min-h-9 rounded-sm border border-border-default bg-surface px-2.5 py-1.5 text-[0.8125rem] text-fg-primary"
          >
            {routes.map((route) => (
              <option key={route.id} value={route.id}>
                {routeLabel(route)}
              </option>
            ))}
          </select>
        </label>

        <label className="grid gap-1.5 text-xs text-fg-muted">
          <span className="font-semibold uppercase">Hostname</span>
          <input
            type="text"
            value={hostname}
            onChange={(event) => onHostnameChange(event.currentTarget.value)}
            spellCheck={false}
            placeholder="app.example.com"
            className="block w-full min-h-9 rounded-sm border border-border-default bg-surface px-2.5 py-1.5 text-[0.8125rem] text-fg-primary"
          />
        </label>

        <div className="grid gap-2 border-t border-border-default pt-3">
          <RecordCell label="Type" value="CNAME" mono={false} />
          <RecordCell label="Name" value={hostname || 'subdomain.example.com'} />
          <RecordCell label="Value" value={selectedRoute?.hostname ?? 'Select a route'} />
          <RecordCell label="Proxy" value="DNS only" mono={false} />
        </div>

        {selectedRoute && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => onCopy(selectedRoute.hostname, 'CNAME value')}
          >
            <Clipboard size={14} />
            Copy CNAME value
          </Button>
        )}

        <Button type="submit" size="sm" loading={saving} disabled={!selectedRoute}>
          <Plus size={14} />
          Add pending domain
        </Button>
      </form>
    </section>
  );
}

function DomainCard({
  domain,
  route,
  verifying,
  deleting,
  onCopy,
  onVerify,
  onDelete,
}: {
  domain: DeploymentCustomDomain;
  route: DeploymentPublicRoute | null;
  verifying: boolean;
  deleting: boolean;
  onCopy: (value: string, label: string) => void;
  onVerify: () => void;
  onDelete: () => void;
}) {
  const meta = statusMeta(domain);
  const cnameTarget = domain.cnameTarget ?? 'No current public route target';
  const copyableCnameTarget = domain.cnameTarget;
  return (
    <article className="grid gap-3 rounded-md border border-border-default bg-inset px-3 py-3">
      <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
        <div className="grid min-w-0 gap-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="break-all text-sm font-semibold text-fg-primary">
              {domain.hostname}
            </span>
            <StatusBadge status={meta.badge} label={meta.label} />
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-muted">
            <span className="inline-flex min-w-0 items-center gap-1">
              <Route size={13} className="shrink-0" />
              <span className="truncate">
                {route ? routeLabel(route) : `${domain.service}:${domain.port}`}
              </span>
            </span>
            <span>created {formatDateTimeCompact(domain.createdAt)}</span>
            {domain.verifiedAt && <span>verified {formatDateTimeCompact(domain.verifiedAt)}</span>}
          </div>
        </div>

        <div className="flex gap-1 sm:justify-end">
          {copyableCnameTarget !== null && (
            <IconButton
              label="Copy DNS value"
              onClick={() => onCopy(copyableCnameTarget, 'DNS value')}
            >
              <Clipboard size={14} />
            </IconButton>
          )}
          <IconButton
            label="Verify domain"
            onClick={onVerify}
            disabled={verifying || domain.cnameTarget === null}
          >
            <RefreshCw size={14} className={verifying ? 'animate-spin' : ''} />
          </IconButton>
          <IconButton
            label="Open domain"
            onClick={() => window.open(`https://${domain.hostname}`, '_blank', 'noreferrer')}
            disabled={route === null || domain.servingStatus !== 'active'}
          >
            <ExternalLink size={14} />
          </IconButton>
          <IconButton label="Remove domain" onClick={onDelete} disabled={deleting} danger>
            <Trash2 size={14} />
          </IconButton>
        </div>
      </div>

      <div className="grid gap-2 border-t border-border-default pt-3">
        <div className={`flex items-start gap-2 text-xs ${meta.tone}`}>
          <TriangleAlert size={14} className="mt-0.5 shrink-0" />
          <span className="min-w-0 break-words">{meta.sentence}</span>
        </div>

        <div className="grid gap-2 sm:grid-cols-4">
          <RecordCell label="Type" value="CNAME" mono={false} />
          <RecordCell label="Name" value={domain.hostname} />
          <RecordCell label="Value" value={cnameTarget} muted={domain.cnameTarget === null} />
          <RecordCell label="Proxy" value="DNS only" mono={false} />
        </div>

        {domain.verificationError && (
          <div className="flex items-start gap-2 rounded-sm bg-danger-tint px-2 py-2 text-xs text-danger-fg">
            <TriangleAlert size={14} className="mt-0.5 shrink-0" />
            <span className="min-w-0 break-words">{domain.verificationError}</span>
          </div>
        )}
      </div>
    </article>
  );
}

function DnsPolicyPanel() {
  return (
    <section className="rounded-md border border-border-default bg-inset px-3 py-3">
      <div className="grid gap-3">
        <div className="flex items-center gap-2 text-sm font-semibold text-fg-primary">
          <Globe2 size={15} />
          DNS checks
        </div>
        <div className="grid gap-2 text-xs text-fg-muted">
          <PolicyLine label="Supported" value="CNAME to the SAM route target" />
          <PolicyLine label="Cloudflare" value="DNS only record before verification" />
          <PolicyLine label="v1 excludes" value="Apex domains, wildcards, TXT challenge" />
          <PolicyLine label="TLS" value="Caddy HTTP-01 on the deployment node" />
        </div>
      </div>
    </section>
  );
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-md border border-border-default bg-inset px-3 py-6 text-center">
      <div className="mx-auto mb-2 flex h-9 w-9 items-center justify-center rounded-md bg-surface text-fg-muted">
        <Globe2 size={18} />
      </div>
      <div className="text-sm font-semibold text-fg-primary">{title}</div>
      <div className="mt-1 text-xs text-fg-muted">{body}</div>
    </div>
  );
}

function PolicyLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[96px_minmax(0,1fr)] gap-2">
      <span className="font-semibold uppercase text-fg-muted">{label}</span>
      <span className="min-w-0 break-words text-fg-primary">{value}</span>
    </div>
  );
}

function RecordCell({
  label,
  value,
  mono = true,
  muted = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
  muted?: boolean;
}) {
  return (
    <div className="grid min-w-0 gap-1">
      <div className="text-[0.6875rem] font-semibold uppercase text-fg-muted">{label}</div>
      <div
        className={`min-w-0 break-all text-xs ${mono ? 'font-mono' : 'font-medium'} ${
          muted ? 'text-fg-muted' : 'text-fg-primary'
        }`}
      >
        {value}
      </div>
    </div>
  );
}

function IconButton({
  label,
  danger = false,
  disabled = false,
  children,
  onClick,
}: {
  label: string;
  danger?: boolean;
  disabled?: boolean;
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      title={label}
      aria-label={label}
      className={`h-9 w-9 px-0 ${danger ? 'text-danger hover:bg-danger-tint' : ''}`}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}
