/**
 * Roles whose consecutive stored rows the chat shows as ONE message.
 *
 * The VM agent stores an agent reply, and a thought, as one row per streamed chunk. The chat
 * merges them (`chatMessagesToConversationItems` in apps/web), the comment context window
 * counts them as one message (`message-context.ts` in apps/api), and `mergedRowAliases`
 * (apps/web) maps every chunk to the message it was merged into. One definition, so the three
 * cannot disagree about where a message starts and ends.
 */
export const MERGED_MESSAGE_ROLES: ReadonlySet<string> = new Set(['assistant', 'thinking']);
