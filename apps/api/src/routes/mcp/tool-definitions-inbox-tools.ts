/**
 * Agent inbox tools (slice D, idea 01M7G03ZCQ6TM6CMEYDRKQ8ST9). Listed to agents as the domain
 * groups `inbox_read` (list, get) and `inbox_write` (ask, review, assign, comment, attach, update,
 * cancel) in
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
    'One sentence the person reads in their inbox, on one line. State exactly what you need.',
};
const why = {
  type: 'string',
  description: 'Short reason and the context the person needs to act without opening the chat.',
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
    name: 'inbox_assign',
    description:
      "Hand a person non-blocking work only a person can do (add a production secret, decide a price, record a demo). It goes to their inbox under Tasks; you keep working. You are woken in this chat when they comment, take it, hand it on, finish, reopen or archive it. It never expires.",
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
            team: { type: 'boolean', enum: [true] },
          },
          additionalProperties: false,
        },
        dueHint: {
          type: 'string',
          description: 'Optional soft due date in words ("before Friday\'s launch"). Sorts and highlights only.',
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
      'Watch an open task another chat assigned instead of assigning a duplicate: this chat is woken by its changes too.',
    inputSchema: {
      type: 'object' as const,
      properties: { ref, wakeOnSteps },
      required: ['ref'],
      additionalProperties: false,
    },
  },
  {
    name: 'inbox_update_item',
    description: 'Edit the title, reason or links of an open item this chat filed.',
    inputSchema: {
      type: 'object' as const,
      properties: { ref, title, why, links },
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
      "One item of this project with its status, the person's answer and the outcome; for a task also its steps, assignee, who took it, activity and discussion.",
    inputSchema: {
      type: 'object' as const,
      properties: { ref },
      required: ['ref'],
      additionalProperties: false,
    },
  },
];
