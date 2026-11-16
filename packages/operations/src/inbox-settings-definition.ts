/**
 * Inbox limits (listed under "Chat" in Admin → Settings). Definitions only, with no imports, so
 * the admin settings registry and the resolver in `inbox-settings.ts` can both depend on it.
 * Runtime settings rather than Worker vars (policy 9017df94, `.claude/rules/07`).
 */
export const INBOX_SETTINGS = [
  {
    name: 'inbox.listPageSize',
    defaultValue: 25,
    description: 'Inbox items one list page returns when the app does not ask for a number.',
    range: { min: 1, max: 200 },
  },
  {
    name: 'inbox.listPageMax',
    defaultValue: 100,
    description: 'Most inbox items one list page may return, whatever the app asks for.',
    range: { min: 1, max: 200 },
  },
  {
    name: 'inbox.titleMaxChars',
    defaultValue: 200,
    description:
      'Characters of an inbox item title. Longer titles are refused when the item is filed.',
    range: { min: 40, max: 1_000 },
  },
  {
    name: 'inbox.bodyMaxChars',
    defaultValue: 4_000,
    description:
      'Characters of an inbox item body (the agent’s reason). Longer bodies are refused when filed.',
    range: { min: 200, max: 20_000 },
  },
  {
    name: 'inbox.linksMax',
    defaultValue: 20,
    description: 'Links one inbox item may carry.',
    range: { min: 0, max: 100 },
  },
  {
    name: 'inbox.openItemsPerChat',
    defaultValue: 20,
    description:
      'Open inbox items one chat may have at once. Filing past it is refused, so a flooding agent cannot bury the inbox.',
    range: { min: 1, max: 500 },
  },
  {
    name: 'inbox.answerMaxChars',
    defaultValue: 4_000,
    description: 'Characters of a typed inbox answer or comment.',
    range: { min: 100, max: 20_000 },
  },
  {
    name: 'inbox.noticeRetryMinutes',
    defaultValue: 60,
    description:
      'Minutes the sweep keeps retrying an agent’s notice that an inbox item was archived or expired.',
    range: { min: 5, max: 1_440 },
  },
  // Questions (`request_human_input`). Defaults are the old HUMAN_INPUT_* Worker defaults
  // (`DEFAULT_HUMAN_INPUT_*`, `packages/shared/src/constants/notifications.ts`); the sweep in
  // `apps/api/src/services/inbox/sweep.ts` runs this schedule (spec section 7).
  {
    name: 'inbox.questionTimeoutMinutes',
    defaultValue: 120,
    description:
      'Minutes an agent question stays open once its notification reached the person. Then it expires and the task stops.',
    range: { min: 1, max: 1_440 },
  },
  {
    name: 'inbox.questionFirstReminderPercent',
    defaultValue: 25,
    description:
      'Point in a question’s window, as a percent, where its push notification is sent again. 0 turns this reminder off.',
    range: { min: 0, max: 99 },
  },
  {
    name: 'inbox.questionSecondReminderPercent',
    defaultValue: 75,
    description:
      'Point in a question’s window, as a percent, where its push notification is sent a last time. 0 turns this reminder off.',
    range: { min: 0, max: 99 },
  },
  {
    name: 'inbox.questionUndeliveredGraceMinutes',
    defaultValue: 120,
    description:
      'Minutes a question is kept open again, and its push resent, when it would expire but no device confirmed its notification.',
    range: { min: 1, max: 1_440 },
  },
  {
    name: 'inbox.questionMaxWaitMinutes',
    defaultValue: 1_440,
    description:
      'Most minutes a question may stay open, even when its notification never reached a device. Never shorter than the question window.',
    range: { min: 1, max: 4_320 },
  },
  {
    name: 'inbox.sweepBatchSize',
    defaultValue: 10,
    description:
      'Inbox items each step of the five-minute sweep handles at most (question reminders, expiries, notice retries). Each costs a write and a notice.',
    range: { min: 1, max: 50 },
  },
] as const;

export type InboxSettingName = (typeof INBOX_SETTINGS)[number]['name'];
