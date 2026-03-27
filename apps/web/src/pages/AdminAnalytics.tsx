import { Card, Spinner, Button, Body } from '@simple-agent-manager/ui';
import { useAdminAnalytics } from '../hooks/useAdminAnalytics';
import {
  DauChart,
  EventsTable,
  FunnelChart,
  PeriodSelector,
  FeatureAdoptionChart,
  GeoDistribution,
  RetentionCohorts,
} from './admin-analytics';

export function AdminAnalytics() {
  const {
    dau,
    events,
    funnel,
    featureAdoption,
    geo,
    retention,
    loading,
    isRefreshing,
    error,
    eventPeriod,
    setEventPeriod,
    refresh,
  } = useAdminAnalytics();

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
      {/* Header with refresh indicator */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h2 className="text-lg font-semibold text-fg-primary">Analytics</h2>
          {isRefreshing && <Spinner size="sm" />}
        </div>
        <div className="flex items-center gap-2">
          <PeriodSelector value={eventPeriod} onChange={setEventPeriod} />
          <Button size="sm" variant="secondary" onClick={refresh}>
            Refresh
          </Button>
        </div>
      </div>

      {/* DAU Chart */}
      <Card>
        <div className="p-4">
          <h3 className="text-sm font-medium text-fg-secondary mb-3">
            Daily Active Users ({dau?.periodDays ?? 30}d)
          </h3>
          <DauChart data={dau?.dau ?? []} />
        </div>
      </Card>

      {/* Conversion Funnel */}
      <Card>
        <div className="p-4">
          <h3 className="text-sm font-medium text-fg-secondary mb-3">
            Conversion Funnel ({funnel?.periodDays ?? 30}d)
          </h3>
          <FunnelChart data={funnel?.funnel ?? []} />
        </div>
      </Card>

      {/* Feature Adoption */}
      <Card>
        <div className="p-4">
          <h3 className="text-sm font-medium text-fg-secondary mb-3">
            Feature Adoption ({featureAdoption?.period ?? '30d'})
          </h3>
          <FeatureAdoptionChart data={featureAdoption} />
        </div>
      </Card>

      {/* Geographic Distribution */}
      <Card>
        <div className="p-4">
          <h3 className="text-sm font-medium text-fg-secondary mb-3">
            Geographic Distribution ({geo?.period ?? '30d'})
          </h3>
          <GeoDistribution data={geo} />
        </div>
      </Card>

      {/* Retention Cohorts */}
      <Card>
        <div className="p-4">
          <h3 className="text-sm font-medium text-fg-secondary mb-3">
            Weekly Retention Cohorts ({retention?.weeks ?? 12}w)
          </h3>
          <RetentionCohorts data={retention} />
        </div>
      </Card>

      {/* Top Events */}
      <Card>
        <div className="p-4">
          <h3 className="text-sm font-medium text-fg-secondary mb-3">Top Events</h3>
          <EventsTable data={events?.events ?? []} />
        </div>
      </Card>
    </div>
  );
}
