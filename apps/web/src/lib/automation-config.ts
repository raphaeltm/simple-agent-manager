/**
 * Tunables for the project Automation page (`pages/automation/`).
 *
 * Every value has a `DEFAULT_*` constant and a `VITE_*` override, per constitution
 * Principle XI and `.claude/rules/60-request-io-and-bundle-budgets.md`. Polls run through
 * TanStack Query's `refetchInterval`, which skips fetches while the tab is hidden (see
 * `lib/poll-intervals.ts`), so no cadence here may set `refetchIntervalInBackground`.
 */

function positiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Refresh cadence for schedules, watches and recent runs while the page is open. */
export const DEFAULT_AUTOMATION_POLL_MS = 30_000;
export const AUTOMATION_POLL_MS = positiveInt(
  import.meta.env.VITE_AUTOMATION_POLL_MS,
  DEFAULT_AUTOMATION_POLL_MS
);

/**
 * How long a one-time automation that failed or could not be confirmed stays in "Needs your
 * attention". The API has no "mark as handled", so a window keeps old problems from
 * accumulating there forever; they stay visible on the item and in History.
 */
export const DEFAULT_AUTOMATION_ATTENTION_WINDOW_MS = 3 * 24 * 60 * 60_000;
export const AUTOMATION_ATTENTION_WINDOW_MS = positiveInt(
  import.meta.env.VITE_AUTOMATION_ATTENTION_WINDOW_MS,
  DEFAULT_AUTOMATION_ATTENTION_WINDOW_MS
);

/**
 * Recent runs fetched per trigger. The API has no project-wide run feed, so the overview reads
 * runs only for paused triggers (attention) and the few that fired most recently ("Recently");
 * History reads them for every trigger.
 */
export const DEFAULT_AUTOMATION_RECENT_RUNS_PER_TRIGGER = 10;
export const AUTOMATION_RECENT_RUNS_PER_TRIGGER = positiveInt(
  import.meta.env.VITE_AUTOMATION_RECENT_RUNS_PER_TRIGGER,
  DEFAULT_AUTOMATION_RECENT_RUNS_PER_TRIGGER
);

/**
 * Pages of one-time schedules and watches the overview reads, at the API's largest page size.
 * Bounded so a project with a long history cannot fan out unbounded requests; the overview says
 * when it stopped early.
 */
export const DEFAULT_AUTOMATION_MAX_LIST_PAGES = 2;
export const AUTOMATION_MAX_LIST_PAGES = positiveInt(
  import.meta.env.VITE_AUTOMATION_MAX_LIST_PAGES,
  DEFAULT_AUTOMATION_MAX_LIST_PAGES
);

/** Rows in the overview's "Coming up" and "Recently" panels. */
export const DEFAULT_AUTOMATION_PREVIEW_ROWS = 5;
export const AUTOMATION_PREVIEW_ROWS = positiveInt(
  import.meta.env.VITE_AUTOMATION_PREVIEW_ROWS,
  DEFAULT_AUTOMATION_PREVIEW_ROWS
);

/** Runs per page on a trigger's own page. */
export const DEFAULT_AUTOMATION_RUNS_PAGE_SIZE = 20;
export const AUTOMATION_RUNS_PAGE_SIZE = positiveInt(
  import.meta.env.VITE_AUTOMATION_RUNS_PAGE_SIZE,
  DEFAULT_AUTOMATION_RUNS_PAGE_SIZE
);

/** Chats offered when an automation messages an existing chat (API maximum is 100). */
export const DEFAULT_AUTOMATION_CHAT_PICKER_LIMIT = 100;
export const AUTOMATION_CHAT_PICKER_LIMIT = Math.min(
  100,
  positiveInt(
    import.meta.env.VITE_AUTOMATION_CHAT_PICKER_LIMIT,
    DEFAULT_AUTOMATION_CHAT_PICKER_LIMIT
  )
);

/** Channel catalog pages (at the API's largest page size) read to sort channels by activity. */
export const DEFAULT_AUTOMATION_MAX_CHANNEL_PAGES = 5;
export const AUTOMATION_MAX_CHANNEL_PAGES = positiveInt(
  import.meta.env.VITE_AUTOMATION_MAX_CHANNEL_PAGES,
  DEFAULT_AUTOMATION_MAX_CHANNEL_PAGES
);
