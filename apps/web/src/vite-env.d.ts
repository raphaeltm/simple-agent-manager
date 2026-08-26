/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
  readonly VITE_FILE_PREVIEW_INLINE_MAX_BYTES?: string;
  readonly VITE_FILE_PREVIEW_LOAD_MAX_BYTES?: string;
  readonly VITE_DEBUG_DIAGNOSIS_EVENT_MAX_PAGES?: string;
  readonly VITE_PROJECT_LIST_LIMIT?: string;
  readonly VITE_PROJECT_POLL_INTERVAL_MS?: string;
  readonly VITE_SIDEBAR_PROJECT_POLL_INTERVAL_MS?: string;
  readonly VITE_WORKSPACE_PORTS_POLL_MS?: string;
  readonly VITE_WORKSPACE_PORTS_BACKOFF_MAX_MS?: string;
  readonly VITE_WORKSPACE_PORTS_FAILURE_BUDGET?: string;
  readonly VITE_WORKSPACE_PORTS_BACKOFF_JITTER_RATIO?: string;
  readonly VITE_WORKSPACE_PORTS_CIRCUIT_RESET_MS?: string;
  readonly VITE_PROJECT_PREFETCH_DELAY_MS?: string;
  readonly VITE_BACKGROUND_FETCH_DELAY_MS?: string;
  readonly VITE_CHUNK_LOAD_RETRY_DELAY_MS?: string;
  readonly VITE_CHUNK_RELOAD_COOLDOWN_MS?: string;
  readonly VITE_ROUTE_FALLBACK_REVEAL_DELAY_MS?: string;
  readonly VITE_QUERY_PERSIST_MAX_AGE_MS?: string;
  readonly VITE_QUERY_PERSIST_THROTTLE_MS?: string;
  readonly VITE_QUERY_PERSIST_RESTORE_TIMEOUT_MS?: string;
  readonly VITE_AGENT_CATALOG_STALE_TIME_MS?: string;
  readonly VITE_PROVIDER_CATALOG_STALE_TIME_MS?: string;
  readonly VITE_TRIAL_STATUS_STALE_TIME_MS?: string;
  readonly VITE_CACHED_COMMANDS_STALE_TIME_MS?: string;
  readonly VITE_PROJECT_CREATE_CONFIG_STALE_TIME_MS?: string;
  readonly DEV: boolean;
  readonly PROD: boolean;
  readonly MODE: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
