import { useState, useEffect, useCallback, useRef } from 'react';
import {
  fetchAnalyticsDau,
  fetchAnalyticsEvents,
  fetchAnalyticsFunnel,
  fetchAnalyticsFeatureAdoption,
  fetchAnalyticsGeo,
  fetchAnalyticsRetention,
  type AnalyticsDauResponse,
  type AnalyticsEventsResponse,
  type AnalyticsFunnelResponse,
  type AnalyticsFeatureAdoptionResponse,
  type AnalyticsGeoResponse,
  type AnalyticsRetentionResponse,
} from '../lib/api';

export interface UseAdminAnalyticsReturn {
  dau: AnalyticsDauResponse | null;
  events: AnalyticsEventsResponse | null;
  funnel: AnalyticsFunnelResponse | null;
  featureAdoption: AnalyticsFeatureAdoptionResponse | null;
  geo: AnalyticsGeoResponse | null;
  retention: AnalyticsRetentionResponse | null;
  loading: boolean;
  isRefreshing: boolean;
  error: string | null;
  eventPeriod: string;
  setEventPeriod: (period: string) => void;
  refresh: () => void;
}

const DEFAULT_REFRESH_INTERVAL = 60_000; // 60 seconds

export function useAdminAnalytics(refreshIntervalMs = DEFAULT_REFRESH_INTERVAL): UseAdminAnalyticsReturn {
  const [dau, setDau] = useState<AnalyticsDauResponse | null>(null);
  const [events, setEvents] = useState<AnalyticsEventsResponse | null>(null);
  const [funnel, setFunnel] = useState<AnalyticsFunnelResponse | null>(null);
  const [featureAdoption, setFeatureAdoption] = useState<AnalyticsFeatureAdoptionResponse | null>(null);
  const [geo, setGeo] = useState<AnalyticsGeoResponse | null>(null);
  const [retention, setRetention] = useState<AnalyticsRetentionResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [eventPeriod, setEventPeriod] = useState('7d');

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
      const [dauRes, eventsRes, funnelRes, adoptionRes, geoRes, retentionRes] = await Promise.all([
        fetchAnalyticsDau(),
        fetchAnalyticsEvents(period),
        fetchAnalyticsFunnel(),
        fetchAnalyticsFeatureAdoption(period),
        fetchAnalyticsGeo(period),
        fetchAnalyticsRetention(),
      ]);

      if (!mountedRef.current) return;

      setDau(dauRes);
      setEvents(eventsRes);
      setFunnel(funnelRes);
      setFeatureAdoption(adoptionRes);
      setGeo(geoRes);
      setRetention(retentionRes);
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
    dau, events, funnel, featureAdoption, geo, retention,
    loading, isRefreshing, error, eventPeriod, setEventPeriod, refresh,
  };
}
