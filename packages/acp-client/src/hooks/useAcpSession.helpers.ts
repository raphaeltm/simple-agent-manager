import type { AgentSessionStatus } from '../transport/types';
import type { AcpSessionState } from './useAcpSession';

/** Default reconnection delay in ms. */
export const DEFAULT_RECONNECT_DELAY_MS = 1000;
/** Default total reconnection timeout in ms. */
export const DEFAULT_RECONNECT_TIMEOUT_MS = 60000;
/** Default maximum reconnection delay cap in ms. */
export const DEFAULT_RECONNECT_MAX_DELAY_MS = 16000;

const RANDOM_UINT32_RANGE = 0x1_0000_0000;
const FALLBACK_JITTER_STEPS = 997;

let fallbackJitterStep = 0;

function randomUnitInterval(): number {
  if (globalThis.crypto?.getRandomValues) {
    const value = new Uint32Array(1);
    globalThis.crypto.getRandomValues(value);
    return (value[0] ?? 0) / RANDOM_UINT32_RANGE;
  }

  fallbackJitterStep = (fallbackJitterStep + 1) % FALLBACK_JITTER_STEPS;
  return fallbackJitterStep / FALLBACK_JITTER_STEPS;
}

/**
 * Add +/-25% jitter to a delay value to prevent thundering-herd reconnections
 * when many clients lose connectivity simultaneously.
 */
export function addJitter(delayMs: number): number {
  const jitterFactor = 0.75 + randomUnitInterval() * 0.5;
  return Math.round(delayMs * jitterFactor);
}

export type CloseCodeStrategy = 'no-reconnect' | 'immediate' | 'backoff';

export function classifyCloseCode(code: number | undefined): CloseCodeStrategy {
  if (code === undefined) return 'backoff';
  switch (code) {
    case 1000:
      return 'no-reconnect';
    case 1001:
      return 'immediate';
    case 1008:
      return 'no-reconnect';
    case 1011:
    case 4000:
    case 4001:
      return 'backoff';
    case 1006:
      return 'immediate';
    default:
      return 'backoff';
  }
}

export function mapAgentStatusToSessionState(status: AgentSessionStatus): AcpSessionState {
  const statusMap: Record<AgentSessionStatus, AcpSessionState> = {
    starting: 'initializing',
    installing: 'initializing',
    ready: 'ready',
    error: 'error',
    restarting: 'initializing',
    recovering: 'initializing',
    recovered: 'ready',
  };

  return statusMap[status] || 'error';
}

/** Extract host from a WebSocket URL for safe logging without tokens. */
export function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'unknown';
  }
}
