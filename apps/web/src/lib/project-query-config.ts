const env = import.meta.env;

function configuredInteger(raw: string | undefined, fallback: number, minimum: number): number {
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isSafeInteger(parsed) && parsed >= minimum ? parsed : fallback;
}

/** Shared project-list result limit. */
export const PROJECT_LIST_LIMIT = configuredInteger(env.VITE_PROJECT_LIST_LIMIT, 50, 1);

/** Default project-list background refresh cadence. Zero disables polling. */
export const PROJECT_POLL_INTERVAL_MS = configuredInteger(
  env.VITE_PROJECT_POLL_INTERVAL_MS,
  30_000,
  0,
);

/** App-shell project-list refresh cadence. Zero disables polling. */
export const SIDEBAR_PROJECT_POLL_INTERVAL_MS = configuredInteger(
  env.VITE_SIDEBAR_PROJECT_POLL_INTERVAL_MS,
  60_000,
  0,
);

/** Mouse dwell before project-detail intent prefetch starts. */
export const PROJECT_PREFETCH_DELAY_MS = configuredInteger(
  env.VITE_PROJECT_PREFETCH_DELAY_MS,
  120,
  0,
);

/** Delay before background query activity is shown or announced. */
export const BACKGROUND_FETCH_DELAY_MS = configuredInteger(
  env.VITE_BACKGROUND_FETCH_DELAY_MS,
  150,
  0,
);
