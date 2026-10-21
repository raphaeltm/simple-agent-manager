/** How failed actions are worded on the Automation page. */

/**
 * True for the API's optimistic-concurrency refusals ("Schedule version conflict", "Standing
 * watch version conflict", "... version or state conflict"): someone else changed the record.
 */
export const isVersionConflict = (error: unknown) =>
  error instanceof Error && /\bversion (or state )?conflict\b/i.test(error.message);

export const VERSION_CONFLICT_TEXT =
  'Someone changed this a moment ago. The page now shows the latest version, so try again.';

export const errorText = (error: unknown, fallback: string) =>
  isVersionConflict(error)
    ? VERSION_CONFLICT_TEXT
    : error instanceof Error && error.message
      ? error.message
      : fallback;
