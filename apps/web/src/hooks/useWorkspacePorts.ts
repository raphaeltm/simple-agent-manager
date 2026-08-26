import type { DetectedPort, WorkspacePortsState, WorkspaceStatus } from '@simple-agent-manager/shared';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';

import {
  WORKSPACE_PORTS_BACKOFF_JITTER_RATIO,
  WORKSPACE_PORTS_BACKOFF_MAX_MS,
  WORKSPACE_PORTS_CIRCUIT_RESET_MS,
  WORKSPACE_PORTS_FAILURE_BUDGET,
  WORKSPACE_PORTS_POLL_MS,
} from '../lib/poll-intervals';
import { workspacePortsQueryOptions } from '../lib/query-options';
import { isWorkspaceOperational } from '../lib/workspace-status-utils';
import { useQueryScope } from './useQueryScope';

const TERMINAL_PORT_STATES = new Set<WorkspacePortsState>([
  'sleeping',
  'stopped',
  'deleted',
  'gone',
  'error',
]);
const RANDOM_UINT32_RANGE = 2 ** 32;

export function useWorkspacePorts(
  workspaceUrl: string | undefined,
  workspaceId: string | undefined,
  token: string | undefined,
  workspaceStatus: WorkspaceStatus | undefined
) {
  const queryScope = useQueryScope();
  const workspaceOperational = isWorkspaceOperational(workspaceStatus);
  const enabled = Boolean(workspaceUrl && workspaceId && token && workspaceOperational && queryScope);
  const lastLoggedErrorAtRef = useRef(0);
  const lastDataAtRef = useRef(0);
  const [lastReadyPorts, setLastReadyPorts] = useState<DetectedPort[]>([]);
  const [consecutiveUnavailable, setConsecutiveUnavailable] = useState(0);
  const [terminalPortsState, setTerminalPortsState] = useState<WorkspacePortsState | null>(null);

  useEffect(() => {
    lastLoggedErrorAtRef.current = 0;
    lastDataAtRef.current = 0;
    setConsecutiveUnavailable(0);
    setTerminalPortsState(null);
    setLastReadyPorts([]);
  }, [workspaceId, workspaceStatus, workspaceUrl, token]);

  const nextRefetchInterval = useMemo(() => {
    if (terminalPortsState) return false;
    return getWorkspacePortsRefetchIntervalMs(consecutiveUnavailable);
  }, [consecutiveUnavailable, terminalPortsState]);

  const query = useQuery({
    ...workspacePortsQueryOptions(queryScope, workspaceUrl ?? '', workspaceId ?? '', token ?? ''),
    enabled,
    refetchInterval: enabled ? nextRefetchInterval : false,
    refetchIntervalInBackground: false,
    retry: false,
  });

  useEffect(() => {
    if (!query.error || query.errorUpdatedAt === 0) return;
    if (query.errorUpdatedAt === lastLoggedErrorAtRef.current) return;
    lastLoggedErrorAtRef.current = query.errorUpdatedAt;
    setTerminalPortsState(null);
    setConsecutiveUnavailable((previous) => {
      const next = incrementUnavailableCount(previous);
      console.warn('useWorkspacePorts: fetch failed', {
        workspaceId,
        consecutiveUnavailable: next,
        circuitOpen: next >= WORKSPACE_PORTS_FAILURE_BUDGET,
        nextRefetchIntervalMs: getWorkspacePortsRefetchIntervalMs(next),
        error: query.error instanceof Error ? query.error.message : String(query.error),
      });
      return next;
    });
  }, [query.error, query.errorUpdatedAt, workspaceId]);

  useEffect(() => {
    if (query.dataUpdatedAt === 0) return;
    if (query.dataUpdatedAt === lastDataAtRef.current) return;
    lastDataAtRef.current = query.dataUpdatedAt;

    const responseState = query.data?.state ?? 'ready';
    if (isTerminalPortsState(responseState)) {
      setLastReadyPorts([]);
      setTerminalPortsState(responseState);
      setConsecutiveUnavailable(WORKSPACE_PORTS_FAILURE_BUDGET);
      return;
    }

    setTerminalPortsState(null);
    if (responseState === 'ready') {
      setLastReadyPorts(query.data?.ports ?? []);
      setConsecutiveUnavailable(0);
      return;
    }

    setConsecutiveUnavailable((previous) => incrementUnavailableCount(previous));
  }, [query.data, query.dataUpdatedAt]);

  const ports: DetectedPort[] = enabled && !terminalPortsState ? lastReadyPorts : [];

  return {
    ports,
    loading: enabled && query.isPending && lastReadyPorts.length === 0 && query.data === undefined,
  };
}

function incrementUnavailableCount(previous: number): number {
  return Math.min(previous + 1, WORKSPACE_PORTS_FAILURE_BUDGET);
}

function isTerminalPortsState(state: WorkspacePortsState): boolean {
  return TERMINAL_PORT_STATES.has(state);
}

function getWorkspacePortsRefetchIntervalMs(consecutiveUnavailable: number): number {
  if (consecutiveUnavailable <= 0) return WORKSPACE_PORTS_POLL_MS;
  if (consecutiveUnavailable >= WORKSPACE_PORTS_FAILURE_BUDGET) {
    return WORKSPACE_PORTS_CIRCUIT_RESET_MS;
  }

  const exponent = Math.max(0, consecutiveUnavailable - 1);
  const rawDelay = Math.min(
    WORKSPACE_PORTS_BACKOFF_MAX_MS,
    WORKSPACE_PORTS_POLL_MS * 2 ** exponent
  );
  return applyJitter(rawDelay, WORKSPACE_PORTS_BACKOFF_JITTER_RATIO);
}

function applyJitter(delayMs: number, jitterRatio: number): number {
  if (jitterRatio <= 0) return delayMs;
  const offset = delayMs * jitterRatio * (randomUnitInterval() * 2 - 1);
  return Math.max(1, Math.round(delayMs + offset));
}

function randomUnitInterval(): number {
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    const value = new Uint32Array(1);
    globalThis.crypto.getRandomValues(value);
    return (value[0] ?? 0) / RANDOM_UINT32_RANGE;
  }
  return 0.5;
}
