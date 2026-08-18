/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
  readonly VITE_FILE_PREVIEW_INLINE_MAX_BYTES?: string;
  readonly VITE_FILE_PREVIEW_LOAD_MAX_BYTES?: string;
  readonly VITE_DEBUG_DIAGNOSIS_EVENT_MAX_PAGES?: string;
  readonly VITE_PROJECT_LIST_LIMIT?: string;
  readonly VITE_PROJECT_POLL_INTERVAL_MS?: string;
  readonly VITE_SIDEBAR_PROJECT_POLL_INTERVAL_MS?: string;
  readonly VITE_PROJECT_PREFETCH_DELAY_MS?: string;
  readonly VITE_BACKGROUND_FETCH_DELAY_MS?: string;
  readonly VITE_CHUNK_LOAD_RETRY_DELAY_MS?: string;
  readonly VITE_CHUNK_RELOAD_COOLDOWN_MS?: string;
  readonly VITE_ROUTE_FALLBACK_REVEAL_DELAY_MS?: string;
  readonly DEV: boolean;
  readonly PROD: boolean;
  readonly MODE: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
