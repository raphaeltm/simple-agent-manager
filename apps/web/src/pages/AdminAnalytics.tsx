import { useState, useEffect, useRef } from 'react';
import { Card, Spinner, Button, Body } from '@simple-agent-manager/ui';
import { useAdminAnalytics } from '../hooks/useAdminAnalytics';
import {
  DauChart,
  EventsTable,
  FunnelChart,
  KpiSummary,
  PeriodSelector,
  FeatureAdoptionChart,
  GeoDistribution,
  RetentionCohorts,
  ForwardingStatus,
  WebsiteTraffic,
} from './admin-analytics';

/** Format "just now" / "Xm ago" / "Xh ago" from a Date. */
function formatLastUpdated(date: Date | null): string {
  if (!date) return '';
  const seconds = Math.round((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const mins = Math.floor(seconds / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  return `${hours}h ago`;
}

export function AdminAnalytics() {
  const {
    dau,
    events,
    funnel,
    featureAdoption,
    geo,
    retention,
    forwardStatus,
    websiteTraffic,
    loading,
    isRefreshing,
    error,
    eventPeriod,
    setEventPeriod,
    refresh,
  } = useAdminAnalytics();

  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(() => (loading ? null : new Date()));
  const [showForwarding, setShowForwarding] = useState(false);
  const prevLoadingRef = useRef(loading);

  // Update lastRefreshed when loading transitions from true→false (data arrived)
  useEffect(() => {
    if (prevLoadingRef.current && !loading) {
      setLastRefreshed(new Date());
    }
    if (!prevLoadingRef.current && !loading && !isRefreshing) {
      // Also update after a manual refresh completes
    }
    prevLoadingRef.current = loading;
  }, [loading, isRefreshing]);

  // Update lastRefreshed when a refresh cycle completes
  const prevRefreshingRef = useRef(isRefreshing);
  useEffect(() => {
    if (prevRefreshingRef.current && !isRefreshing) {
      setLastRefreshed(new Date());
    }
    prevRefreshingRef.current = isRefreshing;
  }, [isRefreshing]);

  if (error && !dau && !events && !funnel) {
    return (
      <Card>
        <div className="p-4 flex flex-col items-center gap-3">
          <Body className="text-danger-fg">{error}</Body>
          <Button size="sm" variant="secondary" onClick={refresh}>
            Retry
          </Button>
        </div>
      </Card>
    );
  }

  if (loading && !dau) {
    return (
      <div className="flex justify-center p-8">
        <Spinner size="lg" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <h2 className="text-xl font-bold text-fg-primary">Analytics</h2>
          {isRefreshing && <Spinner size="sm" />}
          {lastRefreshed && (
            <span className="text-xs text-fg-muted">Updated {formatLastUpdated(lastRefreshed)}</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-fg-muted hidden sm:inline">Data range:</span>
          <PeriodSelector value={eventPeriod} onChange={setEventPeriod} />
          <Button size="sm" variant="secondary" onClick={refresh}>
            Refresh
          </Button>
        </div>
      </div>

      {/* KPI Summary Cards */}
      <KpiSummary dau={dau} funnel={funnel} events={events} />

      {/* DAU Chart — full width */}
      <Card>
        <div className="p-4">
          <h3 className="text-base font-semibold text-fg-primary mb-3">
            Daily Active Users ({dau?.periodDays ?? 30}d)
          </h3>
          <DauChart data={dau?.dau ?? []} />
        </div>
      </Card>

      {/* Two-column grid for medium charts on desktop */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Conversion Funnel */}
        <Card>
          <div className="p-4">
            <h3 className="text-base font-semibold text-fg-primary mb-3">
              Conversion Funnel ({funnel?.periodDays ?? 30}d)
            </h3>
            <FunnelChart data={funnel?.funnel ?? []} />
          </div>
        </Card>

        {/* Feature Adoption */}
        <Card>
          <div className="p-4">
            <h3 className="text-base font-semibold text-fg-primary mb-3">
              Feature Adoption ({featureAdoption?.period ?? '30d'})
            </h3>
            <FeatureAdoptionChart data={featureAdoption} />
          </div>
        </Card>
      </div>

      {/* Geographic Distribution — full width (map needs space) */}
      <Card>
        <div className="p-4">
          <h3 className="text-base font-semibold text-fg-primary mb-3">
            Geographic Distribution ({geo?.period ?? '30d'})
          </h3>
          <GeoDistribution data={geo} />
        </div>
      </Card>

      {/* Retention Cohorts — full width (wide table) */}
      <Card>
        <div className="p-4">
          <h3 className="text-base font-semibold text-fg-primary mb-3">
            Weekly Retention Cohorts ({retention?.weeks ?? 12}w)
          </h3>
          <RetentionCohorts data={retention} />
        </div>
      </Card>

      {/* Two-column grid for secondary data */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Website Traffic */}
        <Card>
          <div className="p-4">
            <h3 className="text-base font-semibold text-fg-primary mb-3">
              Website Traffic ({websiteTraffic?.period ?? eventPeriod})
            </h3>
            <WebsiteTraffic data={websiteTraffic} />
          </div>
        </Card>

        {/* Top Events */}
        <Card>
          <div className="p-4">
            <h3 className="text-base font-semibold text-fg-primary mb-3">Top Events ({events?.period ?? eventPeriod})</h3>
            <EventsTable data={events?.events ?? []} />
          </div>
        </Card>
      </div>

      {/* Event Forwarding — collapsible config section */}
      <Card>
        <button
          type="button"
          className="w-full p-4 flex items-center justify-between text-left"
          onClick={() => setShowForwarding((v) => !v)}
          aria-expanded={showForwarding}
        >
          <span className="text-base font-semibold text-fg-primary">Event Forwarding</span>
          <span className="text-fg-muted text-sm" aria-hidden="true">{showForwarding ? '\u25B2' : '\u25BC'}</span>
        </button>
        {showForwarding && (
          <div className="px-4 pb-4">
            <ForwardingStatus data={forwardStatus} />
          </div>
        )}
      </Card>
    </div>
  );
}
