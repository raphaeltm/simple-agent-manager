const env = import.meta.env;

/**
 * Cadences and result limits for the cross-project chat-summary reads.
 *
 * Mirrors `lib/project-query-config.ts` — a domain's polling cadence and its result
 * limit belong together, because changing one without the other is almost always a
 * mistake.
 *
 * The `VITE_RECENT_CHATS_POLL_MS` and `VITE_RECENT_CHATS_LIMIT` names are carried
 * over verbatim from the pre-migration `useRecentChats.ts`, so existing deployments
 * that set them keep working unchanged.
 */

function configuredInteger(raw: string | undefined, fallback: number, minimum: number): number {
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isSafeInteger(parsed) && parsed >= minimum ? parsed : fallback;
}

/** Recent-chats dropdown refresh cadence. Zero disables polling. */
export const RECENT_CHATS_POLL_INTERVAL_MS = configuredInteger(
  env.VITE_RECENT_CHATS_POLL_MS,
  30_000,
  0
);

/** Sessions shown in the recent-chats dropdown. */
export const RECENT_CHATS_LIMIT = configuredInteger(env.VITE_RECENT_CHATS_LIMIT, 8, 1);

/** Sessions loaded by the `/chats` page. */
export const ALL_CHATS_LIMIT = configuredInteger(env.VITE_ALL_CHATS_LIMIT, 100, 1);
