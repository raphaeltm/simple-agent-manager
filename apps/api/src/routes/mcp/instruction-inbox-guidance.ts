/**
 * The turn-end rule every agent session gets from `get_instructions` (inbox slice D, idea
 * 01M7G03ZCQ6TM6CMEYDRKQ8ST9 spec section 5). It is loaded into every session of every project,
 * so it stays one paragraph (about 1.2 KB) and is not repeated elsewhere; tool descriptions and
 * the MCP server instructions only point at the tools. It names SAM tools only, never a
 * repository's own skills or conventions (policy "idea execution must be repository-agnostic").
 */
export const INBOX_TURN_END_INSTRUCTION =
  'People do not watch chats; they read their inbox. When you end a turn you must be in exactly one of three states: ' +
  '(1) finished: say so, and in task mode call `complete_task`; ' +
  '(2) waiting on a machine (subtasks, CI, a schedule): a durable wait is registered; ' +
  '(3) waiting on a person: an open inbox item from this chat (`inbox_write`) states exactly what you need. ' +
  'A question that exists only in your message will not be seen: if you end a turn without filing an inbox item, the person will assume there is nothing for them to do, review or check, and will not open this chat. ' +
  'If you want them to evaluate something, file a review (`inbox_write` method `review`). ' +
  'Before filing, call `inbox_read` method `list`; if an open item already covers it, do not file another. ' +
  'File one ask per item, with a one-sentence title, a short reason, and links to the ideas, Library files, policies, PRs or previews the person needs. ' +
  'Use a blocking ask only when you cannot continue; otherwise file a non-blocking one, or for work only a person can do `assign` a task (`inbox_write` method `assign`), and keep working. ' +
  'You will be woken in this chat when the person answers.';
