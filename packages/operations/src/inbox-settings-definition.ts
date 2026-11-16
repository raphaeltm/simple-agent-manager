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
  // System error items (slice E, `inbox-error-core.ts`).
  {
    name: 'inbox.automationFailureThreshold',
    defaultValue: 2,
    description:
      'Failed runs in a row that turn an automation into an inbox error item for its owner. The item closes when a run succeeds or the automation is resumed.',
    range: { min: 1, max: 20 },
  },
  {
    name: 'inbox.errorSweepBatchSize',
    defaultValue: 10,
    description:
      'Failed tasks one minute-by-minute sweep turns into inbox error items at most. Each costs a few database writes.',
    range: { min: 1, max: 50 },
  },
  {
    name: 'inbox.errorLookbackMinutes',
    defaultValue: 30,
    description:
      'How far back the sweep looks for failed tasks that have no inbox error item yet. A task that failed longer ago than this is not filed.',
    range: { min: 5, max: 1_440 },
  },
  {
    name: 'inbox.noticeRetryMinutes',
    defaultValue: 60,
    description:
      'Minutes the sweep keeps retrying an agent’s notice that an inbox item was archived or expired.',
    range: { min: 5, max: 1_440 },
  },
  {
    name: 'inbox.sweepBatchSize',
    defaultValue: 10,
    description:
      'Inbox items one five-minute sweep expires or re-notifies at most. Each costs a write and an agent notice.',
    range: { min: 1, max: 50 },
  },
] as const;

export type InboxSettingName = (typeof INBOX_SETTINGS)[number]['name'];
