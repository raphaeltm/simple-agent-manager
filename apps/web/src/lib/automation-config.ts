/**
 * Tunables for the project Automation page (`pages/automation/`).
 *
 * Every value has a `DEFAULT_*` constant and a `VITE_*` override, per constitution
 * Principle XI and `.claude/rules/60-request-io-and-bundle-budgets.md`. The page's refresh
 * cadence lives with the app's other polls: `AUTOMATION_POLL_MS` in `lib/poll-intervals.ts`.
 */

import {
  DEFAULT_WORKFLOW_RUN_LIST_LIMIT,
  MAX_WORKFLOW_RUN_LIST_LIMIT,
} from '@simple-agent-manager/shared';

function positiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

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
 * Recent runs fetched per trigger, and shown on a watch's page before "See all". The API has no
 * project-wide run feed, so the overview reads runs only for paused triggers (attention) and the
 * few that fired most recently ("Recently"); History reads them for every trigger.
 */
export const DEFAULT_AUTOMATION_RECENT_RUNS_PER_TRIGGER = 10;
export const AUTOMATION_RECENT_RUNS_PER_TRIGGER = positiveInt(
  import.meta.env.VITE_AUTOMATION_RECENT_RUNS_PER_TRIGGER,
  DEFAULT_AUTOMATION_RECENT_RUNS_PER_TRIGGER
);

/**
 * Most triggers whose runs one page reads, one request each (there is no project-wide run
 * feed). The overview reads paused triggers first, then the few that fired most recently;
 * History reads the most recently fired. Both say when the cap left some out. The default
 * covers the default per-project trigger limit with room to spare.
 */
export const DEFAULT_AUTOMATION_MAX_RUN_READS = 25;
export const AUTOMATION_MAX_RUN_READS = positiveInt(
  import.meta.env.VITE_AUTOMATION_MAX_RUN_READS,
  DEFAULT_AUTOMATION_MAX_RUN_READS
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

/** The chat list route's own page cap (`apps/api/src/routes/chat-session-list.ts`). */
const CHAT_SESSION_LIST_API_MAX = 100;

/** Chats offered when an automation messages an existing chat, at most the API's page cap. */
export const DEFAULT_AUTOMATION_CHAT_PICKER_LIMIT = CHAT_SESSION_LIST_API_MAX;
export const AUTOMATION_CHAT_PICKER_LIMIT = Math.min(
  CHAT_SESSION_LIST_API_MAX,
  positiveInt(
    import.meta.env.VITE_AUTOMATION_CHAT_PICKER_LIMIT,
    DEFAULT_AUTOMATION_CHAT_PICKER_LIMIT
  )
);

/**
 * Workflow runs per page on the Workflows list, at most the API's page cap. The overview's
 * Workflows panel shows {@link AUTOMATION_PREVIEW_ROWS} of them.
 */
export const DEFAULT_WORKFLOW_RUNS_PAGE_SIZE = DEFAULT_WORKFLOW_RUN_LIST_LIMIT;
export const WORKFLOW_RUNS_PAGE_SIZE = Math.min(
  MAX_WORKFLOW_RUN_LIST_LIMIT,
  positiveInt(import.meta.env.VITE_WORKFLOW_RUNS_PAGE_SIZE, DEFAULT_WORKFLOW_RUNS_PAGE_SIZE)
);

/** Channel catalog pages (at the API's largest page size) read to sort channels by activity. */
export const DEFAULT_AUTOMATION_MAX_CHANNEL_PAGES = 5;
export const AUTOMATION_MAX_CHANNEL_PAGES = positiveInt(
  import.meta.env.VITE_AUTOMATION_MAX_CHANNEL_PAGES,
  DEFAULT_AUTOMATION_MAX_CHANNEL_PAGES
);
