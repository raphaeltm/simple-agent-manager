/**
 * Shared types and utilities for ProjectData DO modules.
 */

export type Env = {
  DATABASE: D1Database;
  BASE_DOMAIN?: string;
  DO_SUMMARY_SYNC_DEBOUNCE_MS?: string;
  MAX_SESSIONS_PER_PROJECT?: string;
  MAX_MESSAGES_PER_SESSION?: string;
  ACTIVITY_RETENTION_DAYS?: string;
  SESSION_IDLE_TIMEOUT_MINUTES?: string;
  IDLE_CLEANUP_RETRY_DELAY_MS?: string;
  IDLE_CLEANUP_MAX_RETRIES?: string;
  ACP_SESSION_DETECTION_WINDOW_MS?: string;
  ACP_SESSION_MAX_FORK_DEPTH?: string;
  WORKSPACE_IDLE_TIMEOUT_MS?: string;
};

export interface SummaryData {
  lastActivityAt: string;
  activeSessionCount: number;
}

export function generateId(): string {
  return crypto.randomUUID();
}
