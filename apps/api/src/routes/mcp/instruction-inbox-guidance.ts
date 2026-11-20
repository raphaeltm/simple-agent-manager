/**
 * The turn-end rule every agent session gets from `get_instructions` (inbox slice D, idea
 * 01M7G03ZCQ6TM6CMEYDRKQ8ST9 spec section 5; Result items, task
 * `tasks/archive/2026-11-18-inbox-result-items-and-turn-end-guidance.md`). It is loaded into every
 * session of every project, so it stays one paragraph (about 1.8 KB) and is not repeated elsewhere;
 * tool descriptions and the MCP server instructions only point at the tools. It names SAM tools
 * only, never a repository's own skills or conventions (policy "idea execution must be
 * repository-agnostic").
 *
 * Raphaël, 2026-11-17: "a human will never see anything in this chat session unless you put it in
 * the inbox ... agents should be careful to only put things that really matter in there and to
 * phrase things in a very human manner." 2026-11-18: "guide agents to use markdown, clear and
 * simple language, and provide some brief easy-to-read context for everything they put in the
 * inbox." The inbox renders `why` as markdown (`InboxItemView`, `InboxItemCard`).
 */
export const INBOX_TURN_END_INSTRUCTION =
  'Nobody reads this chat. A person sees only what you put in their inbox (`inbox_write`), so anything meant for them goes there: ' +
  'the answer or finished work they asked for (method `result`), something you want them to check (`review`), a decision you need (`ask`), or work only a person can do (`assign`). ' +
  'When you end a turn you must be in exactly one of three states: ' +
  '(1) finished: if a person asked for this, file a `result` with what they need; if another agent dispatched this task, report back to that agent instead and file nothing; a routine run with nothing worth a person’s attention files nothing; in task mode also call `complete_task`, and since a person cannot reply to you once your task has completed, `ask` before completing when you need their answer; ' +
  '(2) waiting on a machine (subtasks, CI, a schedule): a durable wait is registered; ' +
  '(3) waiting on a person: an open inbox item from this chat states exactly what you need. ' +
  'If you end a turn without filing an item, the person will assume there is nothing for them and will not open this chat. ' +
  'File only what is worth a person’s time, one thing per item. ' +
  'Write like a short note to a colleague, in clear, simple language: the title is the outcome or the ask in one plain sentence (no markdown); `why` always gives brief, easy-to-read context in markdown (short paragraphs, bullet lists, **bold** for what matters) so they can understand and act without opening the chat; lead with what matters; no IDs, jargon or tool names; link the ideas, Library files, PRs or previews they need instead of pasting them. ' +
  'Before filing, call `inbox_read` method `list`; if an open item already covers it, do not file another. ' +
  'Use a blocking ask only when you cannot continue; otherwise keep working. ' +
  'You will be woken in this chat when the person answers or replies. ' +
  'An inbox reply arrives as a chat message naming the item; it leaves everyone’s inbox until you act. ' +
  'Decide what it means: use inbox_write resolve { ref } if it answers your question, review or result (references their reply); ' +
  'respond { ref, body } to respond on the same item, or update { ref, title / why / links } to change your ask. Respond and update bring it back. ' +
  'Secrets still need the secure field and Operations approvals a person’s decision; you cannot resolve them. A reply to a permission declines it first. ' +
  'Otherwise carry on; it stays archived, even when your task ends. Never file a new item for the same thing.';
