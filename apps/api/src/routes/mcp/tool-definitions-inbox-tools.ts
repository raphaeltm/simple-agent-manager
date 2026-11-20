/**
 * Agent inbox tools (slice D, idea 01M7G03ZCQ6TM6CMEYDRKQ8ST9). Listed to agents as the domain
 * groups `inbox_read` (list, get) and `inbox_write` (ask, review, result, assign, comment, attach,
 * update, cancel) in
 * `tool-groups.ts`; these members stay callable by name. Properties shared by several members are
 * one object each, because a group merges same-named properties and they must agree.
 */
import {
  HUMAN_INPUT_CATEGORIES,
  INBOX_AGENT_LINK_KINDS,
  INBOX_ASK_ANSWER_SHAPES,
} from '@simple-agent-manager/shared';

const title = {
  type: 'string',
  description:
    'One plain sentence (no markdown) the person reads in their inbox, on one line: the outcome, or exactly what you need.',
};
const why = {
  type: 'string',
  description:
    'Always give it: brief, easy-to-read context in markdown (short paragraphs, bullet lists, bold for what matters) and clear, simple language, so the person can understand and act without opening the chat.',
};
const links = {
  type: 'array',
  description:
    'References the person needs (never pasted content): ideas, Library files, policies, knowledge entities, pull requests, previews, other chats. Each must belong to this project.',
  items: {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: [...INBOX_AGENT_LINK_KINDS] },
      id: { type: 'string', description: 'ID of an idea, file, policy, knowledge entity or chat.' },
      url: { type: 'string', description: 'https URL of a pull request (pr) or preview.' },
      label: { type: 'string', description: 'Short chip label.' },
    },
    required: ['kind'],
    additionalProperties: false,
  },
};
const groupKey = {
  type: 'string',
  description: 'Same value for related items from this chat, so they stack together in the inbox.',
};
const idempotencyKey = {
  type: 'string',
  description:
    'Any unique string; a retried call with the same key returns the item already filed.',
};
const ref = { type: 'string', description: 'Item reference, `ask:<id>`, as returned when filed.' };
const replyMessageId = {
  type: 'string',
  description:
    'Exact reply message id from the inbox reply header you received. Required to act on outstanding replies; never guess the latest queued id.',
};
const wakeOnSteps = {
  type: 'boolean',
  description:
    'Default false: step ticks are recorded and you read them at your next wake. true: also wake on each tick (ticks close together arrive together).',
};

export const INBOX_TOOLS = [
  {
    name: 'inbox_ask',
    description:
      "File one question in the person's inbox, with one answer shape: options, free text, or confirm (Yes/No). Use blocking only when you cannot continue.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        title,
        why,
        options: {
          type: 'array',
          items: { type: 'string' },
          description: 'Choices to pick from. Give options or answer, not both.',
        },
        answer: {
          type: 'string',
          enum: [...INBOX_ASK_ANSWER_SHAPES],
          description: 'Without options: `text` (default) or `confirm` (Yes/No).',
        },
        blocking: {
          type: 'boolean',
          description:
            'Default true: you are stopped until answered, and it expires on the usual schedule. false: keep working; it never expires.',
        },
        category: { type: 'string', enum: [...HUMAN_INPUT_CATEGORIES] },
        links,
        groupKey,
        idempotencyKey,
      },
      required: ['title'],
      additionalProperties: false,
    },
  },
  {
    name: 'inbox_review',
    description:
      'Ask the person to evaluate something you made (a PR, preview, file). Non-blocking; they answer "Looks good" or reply.',
    inputSchema: {
      type: 'object' as const,
      properties: { title, why, links, groupKey, idempotencyKey },
      required: ['title'],
      additionalProperties: false,
    },
  },
  {
    name: 'inbox_result',
    description:
      'Hand the person what they asked for: an answer, a finding, finished work. Title: the outcome in one plain sentence. why: the details, written as a short note to a colleague. Non-blocking; they mark it "Got it" (you are not woken) or reply (you are woken with the reply).',
    inputSchema: {
      type: 'object' as const,
      properties: { title, why, links, groupKey, idempotencyKey },
      required: ['title'],
      additionalProperties: false,
    },
  },
  {
    name: 'inbox_assign',
    description:
      'Hand a person non-blocking work only a person can do (add a production secret, decide a price, record a demo). It goes to their inbox under Tasks; you keep working. You are woken in this chat when they comment, take it, hand it on, finish or reopen it; archiving it wakes no one. It never expires.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        title,
        why,
        steps: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional ordered steps, one line each. The person ticks them off.',
        },
        assignee: {
          type: 'object',
          description:
            '`{ "userId": "<id>" }` for one active project member, or `{ "team": true }` for anyone in the project (one member takes it).',
          properties: {
            userId: { type: 'string' },
            team: { type: 'boolean', description: 'true for the team.' },
          },
          additionalProperties: false,
        },
        dueHint: {
          type: 'string',
          description:
            'Optional soft due date in words ("before Friday\'s launch"). Sorts and highlights only.',
        },
        links,
        wakeOnSteps,
        groupKey,
        idempotencyKey,
      },
      required: ['title', 'assignee'],
      additionalProperties: false,
    },
  },
  {
    name: 'inbox_comment',
    description:
      "Reply in a task's discussion (a task this chat assigned or watches, or one addressed to your person or the team). The person is notified.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        ref,
        body: { type: 'string', description: 'Your reply.' },
        threadId: {
          type: 'string',
          description: 'Reply in this discussion thread (from inbox_read get); omit to start one.',
        },
      },
      required: ['ref', 'body'],
      additionalProperties: false,
    },
  },
  {
    name: 'inbox_attach',
    description:
      'Watch an open task another of your chats assigned instead of assigning a duplicate: this chat is woken when it is taken, handed on, finished or reopened (archiving it wakes no one; comments wake the assigning chat; read them with inbox_read get).',
    inputSchema: {
      type: 'object' as const,
      properties: { ref, wakeOnSteps },
      required: ['ref'],
      additionalProperties: false,
    },
  },
  {
    name: 'inbox_respond',
    description:
      'Respond on an item this chat filed, including a pending secret or approval request. The response brings it back to the person’s inbox. Never file a duplicate item.',
    inputSchema: {
      type: 'object' as const,
      properties: { ref, body: { type: 'string' }, replyMessageId },
      required: ['ref', 'body'],
      additionalProperties: false,
    },
  },
  {
    name: 'inbox_resolve',
    description:
      'Treat the observed reply identified by replyMessageId as the answer to this chat’s open question, review or result. Refuses while another reply is outstanding. References its chat message; stays out of their inbox. Cannot resolve secrets, approvals or human tasks.',
    inputSchema: {
      type: 'object' as const,
      properties: { ref, replyMessageId },
      required: ['ref', 'replyMessageId'],
      additionalProperties: false,
    },
  },
  {
    name: 'inbox_update_item',
    description: 'Edit the title, reason or links of an open item this chat filed.',
    inputSchema: {
      type: 'object' as const,
      properties: { ref, title, why, links, replyMessageId },
      required: ['ref'],
      additionalProperties: false,
    },
  },
  {
    name: 'inbox_cancel_item',
    description: 'Close an open item this chat filed because it is moot. Records why.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        ref,
        reason: { type: 'string', description: 'Why the item is no longer needed.' },
      },
      required: ['ref', 'reason'],
      additionalProperties: false,
    },
  },
  {
    name: 'inbox_list_items',
    description:
      'Open inbox items filed from this chat, or (scope project) anywhere in this project. Check before filing.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        scope: { type: 'string', enum: ['chat', 'project'], description: 'Default chat.' },
        limit: { type: 'number', description: 'Items to return.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'inbox_get_item',
    description:
      "One item of this project with its status and outcome; for a task also its progress. Source-chat items include canonical conversation and pendingReplyIds visible on this page, including replies whose delivery failed. Follow conversation cursors while hasMore. Reading observes these replies but does not acknowledge them; explicitly respond/update/resolve with a read reply's id.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        ref,
        replyCursor: {
          type: 'string',
          description: 'conversation.nextReplyCursor from the previous get.',
        },
        responseCursor: {
          type: 'number',
          description: 'conversation.nextResponseCursor from the previous get.',
        },
      },
      required: ['ref'],
      additionalProperties: false,
    },
  },
];
