import { useCallback, useEffect, useRef, useState } from 'react';
import type { NodeLogEntry, NodeLogFilter, NodeLogSource, NodeLogLevel } from '@simple-agent-manager/shared';
import { getNodeLogs, getNodeLogStreamUrl } from '../lib/api';

interface UseNodeLogsOptions {
  nodeId: string | undefined;
  nodeStatus: string | undefined;
}

interface UseNodeLogsReturn {
  entries: NodeLogEntry[];
  loading: boolean;
  error: string | null;
  hasMore: boolean;
  streaming: boolean;
  paused: boolean;
  filter: LogFilterState;
  setSource: (source: NodeLogSource) => void;
  setLevel: (level: NodeLogLevel) => void;
  setContainer: (container: string) => void;
  setSearch: (search: string) => void;
  loadMore: () => void;
  togglePause: () => void;
  refresh: () => void;
}

interface LogFilterState {
  source: NodeLogSource;
  level: NodeLogLevel;
  container: string;
  search: string;
}

const DEFAULT_LIMIT = 200;

export function useNodeLogs({ nodeId, nodeStatus }: UseNodeLogsOptions): UseNodeLogsReturn {
  const [entries, setEntries] = useState<NodeLogEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [paused, setPaused] = useState(false);

  const [filter, setFilter] = useState<LogFilterState>({
    source: 'all',
    level: 'info',
    container: '',
    search: '',
  });

  const cursorRef = useRef<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const mountedRef = useRef(true);
  const pausedRef = useRef(false);
  const pauseBufferRef = useRef<NodeLogEntry[]>([]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Keep pausedRef in sync
  useEffect(() => {
    pausedRef.current = paused;
    // Flush buffer when unpausing
    if (!paused && pauseBufferRef.current.length > 0) {
      setEntries((prev) => [...prev, ...pauseBufferRef.current]);
      pauseBufferRef.current = [];
    }
  }, [paused]);

  const buildFilter = useCallback((): Partial<NodeLogFilter> => ({
    source: filter.source,
    level: filter.level,
    container: filter.container || undefined,
    search: filter.search || undefined,
    limit: DEFAULT_LIMIT,
  }), [filter]);

  // Fetch initial logs
  const fetchLogs = useCallback(async (append = false) => {
    if (!nodeId || nodeStatus !== 'running') return;

    try {
      setLoading(true);
      setError(null);

      const f = buildFilter();
      if (append && cursorRef.current) {
        f.cursor = cursorRef.current;
      }

      const result = await getNodeLogs(nodeId, f);
      if (!mountedRef.current) return;

      const newEntries = result.entries ?? [];
      if (append) {
        setEntries((prev) => [...prev, ...newEntries]);
      } else {
        setEntries(newEntries);
      }
      cursorRef.current = result.nextCursor ?? null;
      setHasMore(result.hasMore);
    } catch (err) {
      if (mountedRef.current) {
        setError(err instanceof Error ? err.message : 'Failed to load logs');
      }
    } finally {
      if (mountedRef.current) {
        setLoading(false);
      }
    }
  }, [nodeId, nodeStatus, buildFilter]);

  // Connect WebSocket for streaming
  const connectStream = useCallback(() => {
    if (!nodeId || nodeStatus !== 'running') return;

    // Close existing connection
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }

    const url = getNodeLogStreamUrl(nodeId, {
      source: filter.source,
      level: filter.level,
      container: filter.container || undefined,
    });

    try {
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        if (mountedRef.current) {
          setStreaming(true);
        }
      };

      ws.onmessage = (event) => {
        if (!mountedRef.current) return;
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'log' && msg.entry) {
            if (pausedRef.current) {
              pauseBufferRef.current.push(msg.entry);
            } else {
              setEntries((prev) => [...prev, msg.entry]);
            }
          } else if (msg.type === 'catchup' && msg.count !== undefined) {
            // Catch-up complete indicator — no action needed
          }
        } catch {
          // Ignore unparseable messages
        }
      };

      ws.onclose = () => {
        if (mountedRef.current) {
          setStreaming(false);
        }
        wsRef.current = null;
      };

      ws.onerror = () => {
        if (mountedRef.current) {
          setStreaming(false);
        }
      };
    } catch {
      setStreaming(false);
    }
  }, [nodeId, nodeStatus, filter.source, filter.level, filter.container]);

  // Load logs and start streaming when filter changes
  useEffect(() => {
    if (!nodeId || nodeStatus !== 'running') {
      setEntries([]);
      setError(null);
      return;
    }

    cursorRef.current = null;
    pauseBufferRef.current = [];
    fetchLogs(false);
    connectStream();

    return () => {
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [nodeId, nodeStatus, fetchLogs, connectStream]);

  const setSource = useCallback((source: NodeLogSource) => {
    setFilter((prev) => {
      // Clear container filter when switching away from docker-relevant sources
      const clearContainer = source !== 'docker' && source !== 'all';
      return { ...prev, source, ...(clearContainer ? { container: '' } : {}) };
    });
  }, []);

  const setLevel = useCallback((level: NodeLogLevel) => {
    setFilter((prev) => ({ ...prev, level }));
  }, []);

  const setContainer = useCallback((container: string) => {
    setFilter((prev) => ({ ...prev, container }));
  }, []);

  const setSearch = useCallback((search: string) => {
    setFilter((prev) => ({ ...prev, search }));
  }, []);

  const loadMore = useCallback(() => {
    if (!loading && hasMore) {
      fetchLogs(true);
    }
  }, [loading, hasMore, fetchLogs]);

  const togglePause = useCallback(() => {
    setPaused((prev) => !prev);
  }, []);

  const refresh = useCallback(() => {
    cursorRef.current = null;
    pauseBufferRef.current = [];
    setPaused(false);
    fetchLogs(false);
  }, [fetchLogs]);

  return {
    entries,
    loading,
    error,
    hasMore,
    streaming,
    paused,
    filter,
    setSource,
    setLevel,
    setContainer,
    setSearch,
    loadMore,
    togglePause,
    refresh,
  };
}
