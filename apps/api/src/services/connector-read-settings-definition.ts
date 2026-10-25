/**
 * Bounds for the Connector's whole-message transcript, schedule, channel and team reads (the
 * "Connector" category in Admin → Settings). Definitions only, with no imports, so the admin
 * settings registry and the resolver in `connector-read-settings.ts` can both depend on it.
 *
 * Every Connector response must also fit `CONNECTOR_RESPONSE_MAX_BYTES` (120 kB by default), and
 * the MCP envelope carries each result twice (text and structured content), so the character
 * budgets below stay well under half of it.
 */
export const CONNECTOR_READ_SETTINGS = [
  {
    name: 'connector.transcriptPageMessages',
    defaultValue: 10,
    description:
      'Whole messages one sam_chat_read page returns when the app does not ask for a number. Tool activity between them is summarized and does not count.',
    range: { min: 1, max: 100 },
  },
  {
    name: 'connector.transcriptScanRows',
    defaultValue: 4_000,
    description:
      'Stored transcript rows one whole-message read examines. Agent replies are stored as many streamed rows, so this bounds how far back one read can reach.',
    range: { min: 250, max: 20_000 },
  },
  {
    name: 'connector.transcriptMessageChars',
    defaultValue: 6_000,
    description:
      'Characters of each message in a transcript page. Longer messages say so and continue with sam_chat_message_get.',
    range: { min: 500, max: 40_000 },
  },
  {
    name: 'connector.transcriptPageChars',
    defaultValue: 24_000,
    description:
      'Characters of message text in one transcript page or one sam_chat_message_get read.',
    range: { min: 2_000, max: 40_000 },
  },
  {
    name: 'connector.searchContextResults',
    defaultValue: 3,
    description:
      'Chat search results that also get an excerpt from the whole message around the match. 0 turns excerpts off.',
    range: { min: 0, max: 10 },
  },
  {
    name: 'connector.searchExcerptChars',
    defaultValue: 600,
    description: 'Characters in each chat search excerpt.',
    range: { min: 100, max: 4_000 },
  },
  {
    name: 'connector.teamMaxTasks',
    defaultValue: 40,
    description: 'Tasks one sam_team_status read reports. Larger teams say how many were left out.',
    range: { min: 1, max: 100 },
  },
  {
    name: 'connector.teamMaxDepth',
    defaultValue: 4,
    description: 'Levels of subtasks below the starting task that sam_team_status reads.',
    range: { min: 1, max: 10 },
  },
  {
    name: 'connector.teamTextChars',
    defaultValue: 600,
    description:
      'Characters of each agent summary, evidence note and question per task in sam_team_status. A team too large for one response gets shorter text first, then lists fewer tasks.',
    range: { min: 100, max: 4_000 },
  },
  {
    name: 'connector.channelHistoryPageSize',
    defaultValue: 20,
    description: 'Channel messages one sam_channel_history page returns by default.',
    range: { min: 1, max: 100 },
  },
  {
    name: 'connector.channelMessageChars',
    defaultValue: 2_000,
    description: 'Characters of each channel message returned to an app.',
    range: { min: 200, max: 4_096 },
  },
] as const;

export type ConnectorReadSettingName = (typeof CONNECTOR_READ_SETTINGS)[number]['name'];
