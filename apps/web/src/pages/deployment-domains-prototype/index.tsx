import { Alert, Button, StatusBadge } from '@simple-agent-manager/ui';
import {
  ArrowLeft,
  CheckCircle2,
  Clipboard,
  ExternalLink,
  Globe2,
  Plus,
  RefreshCw,
  Route,
  ShieldCheck,
  Trash2,
  TriangleAlert,
} from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';

import { formatDateTimeCompact } from '../../components/deployments/deployment-card-format';
import {
  customDomains,
  environmentMock,
  publicRoutes,
  type CustomDomainMock,
  type DomainServingStatus,
  type PublicRouteMock,
} from './mock-data';

const TABS = ['Overview', 'Domains', 'Logs', 'Configuration', 'Policy', 'Node & Metrics'];

const servingStatusMeta: Record<
  DomainServingStatus,
  { badge: string; label: string; tone: string; icon: typeof CheckCircle2 }
> = {
  serving: {
    badge: 'connected',
    label: 'Serving',
    tone: 'text-success',
    icon: CheckCircle2,
  },
  pending_apply: {
    badge: 'stale',
    label: 'Needs apply',
    tone: 'text-warning',
    icon: RefreshCw,
  },
  pending_dns: {
    badge: 'pending',
    label: 'Pending DNS',
    tone: 'text-fg-muted',
    icon: Globe2,
  },
  failed: {
    badge: 'error',
    label: 'DNS mismatch',
    tone: 'text-danger',
    icon: TriangleAlert,
  },
  route_missing: {
    badge: 'error',
    label: 'Route missing',
    tone: 'text-danger',
    icon: TriangleAlert,
  },
};

function routeBadge(route: PublicRouteMock): { status: string; label: string } {
  if (route.status === 'published') return { status: 'completed', label: 'Published' };
  if (route.status === 'changed') return { status: 'stale', label: 'Changed' };
  return { status: 'error', label: 'Removed' };
}

function countForRoute(routeId: string): number {
  return customDomains.filter((domain) => domain.routeId === routeId).length;
}

function selectedRouteLabel(route: PublicRouteMock): string {
  return `${route.service}:${route.port}`;
}

export function DeploymentDomainsPrototype() {
  const fallbackRoute = publicRoutes[0]!;
  const [selectedRouteId, setSelectedRouteId] = useState(fallbackRoute.id);
  const [draftHostname, setDraftHostname] = useState('status.acme.example');
  const selectedRoute = publicRoutes.find((route) => route.id === selectedRouteId) ?? fallbackRoute;

  const selectedDomains = useMemo(
    () => customDomains.filter((domain) => domain.routeId === selectedRoute?.id),
    [selectedRoute?.id]
  );
  const verifiedCount = customDomains.filter(
    (domain) => domain.verificationStatus === 'verified'
  ).length;
  const attentionCount = customDomains.filter(
    (domain) => domain.servingStatus === 'failed' || domain.servingStatus === 'route_missing'
  ).length;
  const pendingCount = customDomains.filter(
    (domain) => domain.servingStatus === 'pending_dns' || domain.servingStatus === 'pending_apply'
  ).length;

  return (
    <div style={{ height: '100vh', overflow: 'auto' }}>
      <main className="mx-auto grid max-w-7xl gap-4 px-4 py-4 sm:px-6 lg:px-8">
        <a
          href="/prototype/deployment-domains"
          className="inline-flex w-fit items-center gap-1 text-sm text-fg-muted no-underline hover:text-fg-primary"
        >
          <ArrowLeft size={15} />
          Deployments
        </a>

        <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="grid min-w-0 gap-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="sam-type-page-title m-0 break-words text-fg-primary">
                {environmentMock.name}
              </h1>
              <StatusBadge status="connected" label={environmentMock.status} />
            </div>
            <div className="text-xs text-fg-muted">
              <span className="font-medium text-fg-primary">{environmentMock.projectName}</span>
              {' / '}
              release v{environmentMock.releaseVersion} {environmentMock.releaseStatus}
              {' / '}
              observed {formatDateTimeCompact(environmentMock.observedAt)}
            </div>
          </div>
          <div className="flex flex-wrap gap-2 sm:justify-end">
            <Button size="sm" variant="secondary">
              <RefreshCw size={14} />
              Verify all
            </Button>
            <Button size="sm" variant="secondary">
              <ShieldCheck size={14} />
              Apply routes
            </Button>
          </div>
        </header>

        <nav
          className="-mb-px flex gap-1 overflow-x-auto border-b border-border-default"
          aria-label="Environment sections"
        >
          {TABS.map((tab) => (
            <button
              key={tab}
              type="button"
              aria-current={tab === 'Domains' ? 'page' : undefined}
              className={`whitespace-nowrap border-b-2 px-3 py-2 text-sm transition-colors ${
                tab === 'Domains'
                  ? 'border-accent font-medium text-fg-primary'
                  : 'border-transparent text-fg-muted hover:text-fg-primary'
              }`}
            >
              {tab}
            </button>
          ))}
        </nav>

        <section className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Metric label="Custom domains" value={customDomains.length.toString()} />
          <Metric label="Verified" value={verifiedCount.toString()} />
          <Metric label="Pending" value={pendingCount.toString()} />
          <Metric label="Attention" value={attentionCount.toString()} tone="text-warning" />
        </section>

        <Alert variant="info">
          v1 accepts subdomains only. SAM verifies that the hostname resolves to the SAM-owned route
          target before adding it to the deployment node's Caddy config.
        </Alert>

        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
          <section className="grid gap-4">
            <RouteSelector selectedRouteId={selectedRouteId} onSelect={setSelectedRouteId} />

            <section className="grid gap-3">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
                <div className="grid gap-1">
                  <h2 className="sam-type-section-heading m-0 text-fg-primary">Custom domains</h2>
                  <div className="text-xs text-fg-muted">
                    Showing {selectedDomains.length} for {selectedRouteLabel(selectedRoute)}
                  </div>
                </div>
                <Button size="sm" variant="secondary">
                  <RefreshCw size={14} />
                  Refresh DNS
                </Button>
              </div>

              {selectedDomains.length === 0 ? (
                <EmptyDomains route={selectedRoute} />
              ) : (
                <div className="grid gap-2">
                  {selectedDomains.map((domain) => (
                    <DomainCard
                      key={domain.id}
                      domain={domain}
                      route={publicRoutes.find((route) => route.id === domain.routeId) ?? null}
                    />
                  ))}
                </div>
              )}
            </section>
          </section>

          <aside className="grid content-start gap-4">
            <AddDomainPanel
              selectedRoute={selectedRoute}
              draftHostname={draftHostname}
              onDraftHostnameChange={setDraftHostname}
              onRouteChange={setSelectedRouteId}
            />
            <DnsPolicyPanel />
          </aside>
        </div>
      </main>
    </div>
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
  selectedRouteId,
  onSelect,
}: {
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
        {publicRoutes.map((route) => {
          const selected = route.id === selectedRouteId;
          const badge = routeBadge(route);
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
                    {route.service}:{route.port}
                  </div>
                  <div className="break-all text-xs text-fg-muted">{route.hostname}</div>
                </div>
                <StatusBadge status={badge.status} label={badge.label} />
              </div>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-muted">
                <span>host port {route.hostPort}</span>
                <span>release v{route.releaseVersion}</span>
                <span>{countForRoute(route.id)} domains</span>
              </div>
            </button>
          );
        })}
      </div>
    </section>
  );
}

function AddDomainPanel({
  selectedRoute,
  draftHostname,
  onDraftHostnameChange,
  onRouteChange,
}: {
  selectedRoute: PublicRouteMock;
  draftHostname: string;
  onDraftHostnameChange: (value: string) => void;
  onRouteChange: (routeId: string) => void;
}) {
  return (
    <section className="rounded-md border border-border-default bg-inset px-3 py-3">
      <form className="grid gap-3" onSubmit={(event) => event.preventDefault()}>
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-sm font-semibold text-fg-primary">
            <Plus size={15} />
            Add domain
          </div>
          <StatusBadge status="pending" label="Creates pending" />
        </div>

        <label className="grid gap-1.5">
          <span className="text-[0.6875rem] font-semibold uppercase text-fg-muted">Route</span>
          <select
            value={selectedRoute.id}
            onChange={(event) => onRouteChange(event.currentTarget.value)}
          >
            {publicRoutes
              .filter((route) => route.status !== 'removed')
              .map((route) => (
                <option key={route.id} value={route.id}>
                  {route.service}:{route.port}
                </option>
              ))}
          </select>
        </label>

        <label className="grid gap-1.5">
          <span className="text-[0.6875rem] font-semibold uppercase text-fg-muted">Hostname</span>
          <input
            type="text"
            value={draftHostname}
            onChange={(event) => onDraftHostnameChange(event.currentTarget.value)}
            spellCheck={false}
          />
        </label>

        <div className="grid gap-2 border-t border-border-default pt-3">
          <RecordCell label="Type" value="CNAME" mono={false} />
          <RecordCell label="Name" value={draftHostname || 'subdomain.example.com'} />
          <RecordCell label="Value" value={selectedRoute.hostname} />
          <RecordCell label="Proxy" value="DNS only" mono={false} />
        </div>

        <Button type="submit" size="sm">
          <Plus size={14} />
          Add pending domain
        </Button>
      </form>
    </section>
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

function PolicyLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[96px_minmax(0,1fr)] gap-2">
      <span className="font-semibold uppercase text-fg-muted">{label}</span>
      <span className="min-w-0 break-words text-fg-primary">{value}</span>
    </div>
  );
}

function EmptyDomains({ route }: { route: PublicRouteMock }) {
  return (
    <div className="rounded-md border border-border-default bg-inset px-3 py-6 text-center">
      <div className="mx-auto mb-2 flex h-9 w-9 items-center justify-center rounded-md bg-surface text-fg-muted">
        <Globe2 size={18} />
      </div>
      <div className="text-sm font-semibold text-fg-primary">
        No custom domains on {route.service}:{route.port}
      </div>
      <div className="mt-1 text-xs text-fg-muted">Add one from the panel beside this route.</div>
    </div>
  );
}

function DomainCard({
  domain,
  route,
}: {
  domain: CustomDomainMock;
  route: PublicRouteMock | null;
}) {
  const meta = servingStatusMeta[domain.servingStatus];
  const StatusIcon = meta.icon;
  const routeLabel = route ? `${route.service}:${route.port}` : `${domain.service}:${domain.port}`;

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
              <span className="truncate">{routeLabel}</span>
            </span>
            <span>created {formatDateTimeCompact(domain.createdAt)}</span>
            <span>checked {formatDateTimeCompact(domain.checkedAt)}</span>
          </div>
        </div>

        <div className="flex gap-1 sm:justify-end">
          <IconButton label="Copy DNS value">
            <Clipboard size={14} />
          </IconButton>
          <IconButton label="Verify domain">
            <RefreshCw size={14} />
          </IconButton>
          <IconButton label="Open domain">
            <ExternalLink size={14} />
          </IconButton>
          <IconButton label="Remove domain" danger>
            <Trash2 size={14} />
          </IconButton>
        </div>
      </div>

      <div className="grid gap-2 border-t border-border-default pt-3">
        <div className={`flex items-start gap-2 text-xs ${meta.tone}`}>
          <StatusIcon size={14} className="mt-0.5 shrink-0" />
          <span className="min-w-0 break-words">{statusSentence(domain, route)}</span>
        </div>

        <div className="grid gap-2 sm:grid-cols-4">
          <RecordCell label="Type" value="CNAME" mono={false} />
          <RecordCell label="Name" value={domain.hostname} />
          <RecordCell
            label="Value"
            value={domain.cnameTarget ?? 'No current public route target'}
            muted={!domain.cnameTarget}
          />
          <RecordCell label="Proxy" value="DNS only" mono={false} />
        </div>

        {domain.error && (
          <div className="flex items-start gap-2 rounded-sm bg-danger-tint px-2 py-2 text-xs text-danger-fg">
            <TriangleAlert size={14} className="mt-0.5 shrink-0" />
            <span className="min-w-0 break-words">{domain.error}</span>
          </div>
        )}
      </div>
    </article>
  );
}

function statusSentence(domain: CustomDomainMock, route: PublicRouteMock | null): string {
  if (domain.servingStatus === 'serving') {
    return `Verified ${formatDateTimeCompact(domain.verifiedAt)} and serving through ${route?.hostname ?? domain.cnameTarget}.`;
  }
  if (domain.servingStatus === 'pending_apply') {
    return 'DNS is verified. Apply routes to add the hostname to Caddy on the deployment node.';
  }
  if (domain.servingStatus === 'pending_dns') {
    return 'Waiting for DNS to resolve to the route target before activation.';
  }
  if (domain.servingStatus === 'route_missing') {
    return 'The parent public route is missing from the current release.';
  }
  return 'Verification failed against the expected route target.';
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
  children,
}: {
  label: string;
  danger?: boolean;
  children: ReactNode;
}) {
  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      title={label}
      aria-label={label}
      className={`h-9 w-9 px-0 ${danger ? 'text-danger hover:bg-danger-tint' : ''}`}
    >
      {children}
    </Button>
  );
}
