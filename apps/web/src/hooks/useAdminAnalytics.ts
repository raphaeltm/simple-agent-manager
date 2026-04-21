import { useCallback, useEffect, useRef,useState } from 'react';

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

export function useAdminAnalytics(refreshIntervalMs = DEFAULT_REFRESH_INTERVAL): UseAdminAnalyticsReturn {
  const [dau, setDau] = useState<AnalyticsDauResponse | null>(null);
  const [events, setEvents] = useState<AnalyticsEventsResponse | null>(null);
  const [funnel, setFunnel] = useState<AnalyticsFunnelResponse | null>(null);
  const [featureAdoption, setFeatureAdoption] = useState<AnalyticsFeatureAdoptionResponse | null>(null);
  const [geo, setGeo] = useState<AnalyticsGeoResponse | null>(null);
  const [retention, setRetention] = useState<AnalyticsRetentionResponse | null>(null);
  const [forwardStatus, setForwardStatus] = useState<AnalyticsForwardStatusResponse | null>(null);
  const [websiteTraffic, setWebsiteTraffic] = useState<AnalyticsWebsiteTrafficResponse | null>(null);
  const [aiUsage, setAiUsage] = useState<AnalyticsAiUsageResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [eventPeriod, setEventPeriod] = useState(DEFAULT_ANALYTICS_PERIOD);

  const mountedRef = useRef(true);
  const hasLoadedRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const fetchAll = useCallback(async (period: string) => {
    if (hasLoadedRef.current) {
      setIsRefreshing(true);
    }
    try {
      setError(null);
      const [dauRes, eventsRes, funnelRes, adoptionRes, geoRes, retentionRes, forwardRes, websiteTrafficRes, aiUsageRes] = await Promise.all([
        fetchAnalyticsDau(),
        fetchAnalyticsEvents(period),
        fetchAnalyticsFunnel(),
        fetchAnalyticsFeatureAdoption(period),
        fetchAnalyticsGeo(period),
        fetchAnalyticsRetention(),
        fetchAnalyticsForwardStatus(),
        fetchAnalyticsWebsiteTraffic(period),
        fetchAnalyticsAiUsage(period).catch(() => null),
      ]);

      if (!mountedRef.current) return;

      setDau(dauRes);
      setEvents(eventsRes);
      setFunnel(funnelRes);
      setFeatureAdoption(adoptionRes);
      setGeo(geoRes);
      setRetention(retentionRes);
      setForwardStatus(forwardRes);
      setWebsiteTraffic(websiteTrafficRes);
      setAiUsage(aiUsageRes);
    } catch (err) {
      if (mountedRef.current) {
        setError(err instanceof Error ? err.message : 'Failed to load analytics data');
      }
    } finally {
      if (mountedRef.current) {
        hasLoadedRef.current = true;
        setLoading(false);
        setIsRefreshing(false);
      }
    }
  }, []);

  // Fetch on mount and when period changes
  useEffect(() => {
    fetchAll(eventPeriod);
  }, [fetchAll, eventPeriod]);

  // Auto-refresh
  useEffect(() => {
    if (!refreshIntervalMs || refreshIntervalMs <= 0) return;
    const id = setInterval(() => fetchAll(eventPeriod), refreshIntervalMs);
    return () => clearInterval(id);
  }, [refreshIntervalMs, fetchAll, eventPeriod]);

  const refresh = useCallback(() => {
    fetchAll(eventPeriod);
  }, [fetchAll, eventPeriod]);

  return {
    dau, events, funnel, featureAdoption, geo, retention, forwardStatus, websiteTraffic, aiUsage,
    loading, isRefreshing, error, eventPeriod, setEventPeriod, refresh,
  };
}
