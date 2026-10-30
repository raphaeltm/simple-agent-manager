import { useQueries } from '@tanstack/react-query';
import { useState } from 'react';

import {
  type AnalyticsAiUsageResponse,
  type AnalyticsDauResponse,
  type AnalyticsEventsResponse,
  type AnalyticsFeatureAdoptionResponse,
  type AnalyticsForwardStatusResponse,
  type AnalyticsFunnelResponse,
  type AnalyticsGeoResponse,
  type AnalyticsRetentionResponse,
  type AnalyticsWebsiteTrafficResponse,
  fetchAnalyticsAiUsage,
  fetchAnalyticsDau,
  fetchAnalyticsEvents,
  fetchAnalyticsFeatureAdoption,
  fetchAnalyticsForwardStatus,
  fetchAnalyticsFunnel,
  fetchAnalyticsGeo,
  fetchAnalyticsRetention,
  fetchAnalyticsWebsiteTraffic,
} from '../lib/api';
import { PROJECT_CREATE_CONFIG_STALE_TIME_MS } from '../lib/query-stale-times';
import { useQueryScope } from './useQueryScope';

export interface UseAdminAnalyticsReturn {
  dau: AnalyticsDauResponse | null;
  events: AnalyticsEventsResponse | null;
  funnel: AnalyticsFunnelResponse | null;
  featureAdoption: AnalyticsFeatureAdoptionResponse | null;
  geo: AnalyticsGeoResponse | null;
  retention: AnalyticsRetentionResponse | null;
  forwardStatus: AnalyticsForwardStatusResponse | null;
  websiteTraffic: AnalyticsWebsiteTrafficResponse | null;
  aiUsage: AnalyticsAiUsageResponse | null;
  loading: boolean;
  isRefreshing: boolean;
  error: string | null;
  eventPeriod: string;
  setEventPeriod: (period: string) => void;
  refresh: () => void;
}

const DEFAULT_REFRESH_INTERVAL = 60_000; // 60 seconds
const DEFAULT_ANALYTICS_PERIOD = '7d';

export function useAdminAnalytics(
  refreshIntervalMs = DEFAULT_REFRESH_INTERVAL
): UseAdminAnalyticsReturn {
  const scope = useQueryScope();
  const [eventPeriod, setEventPeriod] = useState(DEFAULT_ANALYTICS_PERIOD);
  const base = {
    enabled: Boolean(scope),
    refetchInterval: refreshIntervalMs > 0 ? refreshIntervalMs : (false as const),
    refetchIntervalInBackground: false,
  };
  const key = (name: string, period?: string) => [
    'auth',
    scope,
    'admin-analytics',
    name,
    period ?? null,
  ];
  const queries = useQueries({
    queries: [
      { ...base, queryKey: key('dau'), queryFn: ({ signal }) => fetchAnalyticsDau(signal) },
      {
        ...base,
        queryKey: key('events', eventPeriod),
        queryFn: ({ signal }) => fetchAnalyticsEvents(eventPeriod, signal),
      },
      { ...base, queryKey: key('funnel'), queryFn: ({ signal }) => fetchAnalyticsFunnel(signal) },
      {
        ...base,
        queryKey: key('adoption', eventPeriod),
        queryFn: ({ signal }) => fetchAnalyticsFeatureAdoption(eventPeriod, signal),
      },
      {
        ...base,
        queryKey: key('geo', eventPeriod),
        queryFn: ({ signal }) => fetchAnalyticsGeo(eventPeriod, signal),
      },
      {
        ...base,
        queryKey: key('retention'),
        queryFn: ({ signal }) => fetchAnalyticsRetention(undefined, signal),
      },
      {
        ...base,
        queryKey: key('forward-status'),
        queryFn: ({ signal }) => fetchAnalyticsForwardStatus(signal),
      },
      {
        ...base,
        queryKey: key('website', eventPeriod),
        queryFn: ({ signal }) => fetchAnalyticsWebsiteTraffic(eventPeriod, signal),
      },
      {
        ...base,
        queryKey: key('ai-usage', eventPeriod),
        queryFn: ({ signal }) => fetchAnalyticsAiUsage(eventPeriod, signal),
        staleTime: PROJECT_CREATE_CONFIG_STALE_TIME_MS,
        refetchInterval:
          refreshIntervalMs > 0
            ? Math.max(refreshIntervalMs, PROJECT_CREATE_CONFIG_STALE_TIME_MS)
            : (false as const),
      },
    ],
  });
  const [
    dau,
    events,
    funnel,
    featureAdoption,
    geo,
    retention,
    forwardStatus,
    websiteTraffic,
    aiUsage,
  ] = queries;
  return {
    dau: dau.data ?? null,
    events: events.data ?? null,
    funnel: funnel.data ?? null,
    featureAdoption: featureAdoption.data ?? null,
    geo: geo.data ?? null,
    retention: retention.data ?? null,
    forwardStatus: forwardStatus.data ?? null,
    websiteTraffic: websiteTraffic.data ?? null,
    aiUsage: aiUsage.data ?? null,
    // Reveal each settled panel while others continue loading.
    loading: queries.every((query) => query.isPending),
    isRefreshing: queries.some((query) => query.isFetching && query.data !== undefined),
    error: (() => {
      const failure = queries.find((query) => query.error)?.error;
      return failure
        ? failure instanceof Error
          ? failure.message
          : 'Failed to load analytics data'
        : null;
    })(),
    eventPeriod,
    setEventPeriod,
    refresh: () => {
      for (const query of queries) void query.refetch();
    },
  };
}
