/**
 * Activity mock data for the Automation prototype: run history, what agents are waiting
 * on, and agent channels. Split from mock-data.ts (file size rule); see that file's header.
 */
import type { Kind, Outcome } from './mock-data';
import {
  at,
  chatAt,
  DOCS_LAST,
  FOLLOWUP_DUE,
  JOURNAL_LAST,
  STANDUP_LAST,
  STORAGE_DUE,
} from './mock-data';
import { clock } from './time';

export interface Run {
  id: string;
  automationId: string;
  at: number;
  outcome: Outcome;
  /** Plain-language line, e.g. "Started a chat" or why it was ignored. */
  text: string;
  detail?: string;
  durationMin?: number;
  chatId?: string;
}

export const RUNS: Run[] = (
  [
    {
      id: 'r1',
      automationId: 'flaky',
      at: at(-11),
      outcome: 'running',
      text: 'Waiting for the chat to finish its turn',
      detail: `Attempt 3 of 12 · next try at ${clock(at(4))}`,
    },
    {
      id: 'r2',
      automationId: 'ci-red',
      at: at(-5 * 60),
      outcome: 'delivered',
      text: 'Messaged “PR #2387 release shepherd”',
      chatId: 'chat-release',
    },
    {
      id: 'r3',
      automationId: 'incident',
      at: at(-5 * 60 - 3),
      outcome: 'ok',
      text: 'Started a chat · 4 incidents triaged',
      durationMin: 12,
    },
    {
      id: 'r4',
      automationId: 'storage',
      at: STORAGE_DUE,
      outcome: 'ok',
      text: 'Started a chat',
      durationMin: 9,
    },
    {
      id: 'r5',
      automationId: 'review-followup',
      at: FOLLOWUP_DUE,
      outcome: 'unknown',
      text: 'Couldn’t confirm the message arrived',
      detail: 'The chat restarted while SAM was sending it',
    },
    {
      id: 'r6',
      automationId: 'journal',
      at: JOURNAL_LAST,
      outcome: 'ok',
      text: 'Started a chat · post published',
      durationMin: 21,
      chatId: 'chat-audit',
    },
    {
      id: 'r7',
      automationId: 'shepherd',
      at: at(-9 * 60),
      outcome: 'failed',
      text: 'Still going after the 30-minute limit',
      detail: 'SAM stopped waiting for it. The chat may have kept working.',
      durationMin: 46,
    },
    {
      id: 'r8',
      automationId: 'shepherd',
      at: at(-15 * 60),
      outcome: 'failed',
      text: 'The agent stopped responding',
      detail: 'No reply after SAM’s check-in',
      durationMin: 3,
    },
    {
      id: 'r9',
      automationId: 'shepherd',
      at: at(-21 * 60),
      outcome: 'failed',
      text: 'No machine available',
      detail: 'Hetzner: server limit reached (403)',
      durationMin: 1,
    },
    {
      id: 'r10',
      automationId: 'standup',
      at: STANDUP_LAST,
      outcome: 'ok',
      text: 'Started a chat',
      durationMin: 6,
    },
    {
      id: 'r11',
      automationId: 'deploy',
      at: at(-26 * 60),
      outcome: 'ok',
      text: 'Started a chat · deploy failed on “migrate”',
      durationMin: 14,
    },
    {
      id: 'r12',
      automationId: 'deploy',
      at: at(-27 * 60),
      outcome: 'ignored',
      text: 'Ignored a delivery: the deploy succeeded',
      detail: 'workflow_run.conclusion was "success", filter needs "failure"',
    },
    {
      id: 'r13',
      automationId: 'deploy',
      at: at(-26 * 60 + 1),
      outcome: 'ignored',
      text: 'Ignored a duplicate delivery',
      detail: 'Same Idempotency-Key as 1 minute earlier',
    },
    {
      id: 'r14',
      automationId: 'shepherd',
      at: at(-27 * 60),
      outcome: 'ok',
      text: 'Started a chat · merged 3 PRs',
      durationMin: 64,
    },
    {
      id: 'r15',
      automationId: 'sam-cmd',
      at: at(-30 * 60),
      outcome: 'ok',
      text: 'Started a chat for issue #2342',
      durationMin: 18,
    },
    {
      id: 'r16',
      automationId: 'shepherd',
      at: at(-33 * 60),
      outcome: 'skipped',
      text: 'Skipped: the previous run was still going',
    },
    {
      id: 'r17',
      automationId: 'docs',
      at: DOCS_LAST,
      outcome: 'ok',
      text: 'Started a chat · 2 docs fixed',
      durationMin: 33,
    },
    {
      id: 'r18',
      automationId: 'deploy',
      at: at(-50 * 60),
      outcome: 'skipped',
      text: 'Skipped: one investigation was already running',
    },
    {
      id: 'r19',
      automationId: 'deploy',
      at: at(-70 * 60),
      outcome: 'failed',
      text: 'Couldn’t start: no agent profile set',
      detail: 'Fixed since: profile is now “Backend Implementation”',
    },
  ] as Run[]
).sort((x, y) => y.at - x.at);

export interface Wait {
  id: string;
  chatId: string;
  /** "is waiting for …" in plain words. */
  waitingFor: string;
  until: number;
  state: 'waiting' | 'ended';
  endNote?: string;
  system?: boolean;
  technical: Array<[string, string]>;
}

const CI_EVENTS = 'check_run.completed, check_suite.completed, workflow_run.completed';

export const WAITS: Wait[] = [
  {
    id: 'w1',
    chatId: 'chat-release',
    waitingFor: 'CI checks to finish on commit 14aee28 (PR #2387)',
    until: at(5 * 60 + 40),
    state: 'waiting',
    technical: [
      ['Source', 'github'],
      ['Subject', 'commit · 14aee2827fa0c1d8be3a55e09e0c5f2b6d7a9c31'],
      ['Event types', CI_EVENTS],
      ['Delivery', 'Wakes the chat with a message (queued for prompt delivery)'],
      ['Created by', 'agent 01M5MOCKAGNT00000000000002'],
      ['Subscription ID', 'sub_01M5MOCKSUBS0000000000002'],
    ],
  },
  {
    id: 'w2',
    chatId: 'chat-release',
    waitingFor: 'a review or comment on PR #2387',
    until: at(22 * 60),
    state: 'waiting',
    technical: [
      ['Source', 'github'],
      ['Subject', 'pull_request · 2387'],
      ['Event types', 'pull_request_review.submitted, issue_comment.created'],
      ['Delivery', 'Wakes the chat with a message'],
      ['Subscription ID', 'sub_01M5MOCKSUBS0000000000006'],
    ],
  },
  {
    id: 'w3',
    chatId: 'chat-comments',
    waitingFor: 'new posts in #feature.multiplayer',
    until: at(5 * 60),
    state: 'waiting',
    technical: [
      ['Source', 'sam.agent_channel'],
      ['Subject', 'agent_channel · feature.multiplayer'],
      ['Delivery', 'Wakes the chat with a message'],
      ['Subscription ID', 'sub_01M5MOCKSUBS0000000000007'],
    ],
  },
  ...Array.from({ length: 8 }, (_, i): Wait => ({
    id: `relay-${i}`,
    chatId: chatAt(i).id,
    waitingFor: `messages from “${chatAt(i + 1).title}”`,
    until: at(6 * 60 - i * 20),
    state: 'waiting',
    system: true,
    technical: [
      [
        'What this is',
        'SAM’s message relay between two agent chats. Created and renewed automatically.',
      ],
      ['Channel', `agent-dm.${(0x512d4711 + i * 7919).toString(16)}c02c6536dddaed138f6168cfed63e7`],
      ['Subscription ID', `sub_01M5MOCKRELAY000000000000${i}`],
    ],
  })),
  ...Array.from({ length: 6 }, (_, i): Wait => ({
    id: `ended-${i}`,
    chatId: chatAt(i + 2).id,
    waitingFor: `CI checks to finish on PR #${2380 - i}`,
    until: at(-(200 + i * 90)),
    state: 'ended',
    endNote: i % 2 === 0 ? 'Checks finished · chat woken' : 'Stopped waiting after 6 hours',
    technical: [['Subscription ID', `sub_01M5MOCKSUBS00000000000${20 + i}`]],
  })),
];

export interface Channel {
  name: string;
  posts: number;
  lastAt: number;
  lastBy: string;
  lastText: string;
  following: number;
}

export const CHANNELS: Channel[] = [
  {
    name: 'feature.events-ux',
    posts: 4,
    lastAt: at(-3),
    lastBy: 'Audit events UI and subpages',
    lastText: 'Done with staging, cleaned up the test node.',
    following: 2,
  },
  {
    name: 'feature.multiplayer',
    posts: 63,
    lastAt: at(-40),
    lastBy: 'Multiplayer comments follow-ups',
    lastText: 'Mention inbox filters are merged; review shortcut next.',
    following: 3,
  },
  {
    name: 'reliability-wave-1020',
    posts: 38,
    lastAt: at(-9 * 60),
    lastBy: 'Fix webhook delivery retries',
    lastText: 'Wave finished. Handing back to the coordinator.',
    following: 0,
  },
  {
    name: 'reliability-wave-1008',
    posts: 211,
    lastAt: at(-12 * 24 * 60),
    lastBy: 'Coordinator',
    lastText: 'All four workstreams merged and deployed.',
    following: 0,
  },
];
export const DIRECT_THREADS = 30;

export const CHANNEL_POSTS = [
  {
    by: 'Audit events UI and subpages',
    at: at(-40),
    text: 'Kickoff: auditing Events + Triggers. Read-only; findings will land in an idea.',
  },
  {
    by: 'Audit events UI and subpages',
    at: at(-32),
    text: 'Subscriptions tab done. Moving to Schedules.',
  },
  {
    by: 'Fix webhook delivery retries',
    at: at(-24),
    text: 'Is anyone else using staging right now? I need ~20 minutes.',
  },
  {
    by: 'Audit events UI and subpages',
    at: at(-3),
    text: 'Done with staging, cleaned up the test node.',
  },
];

export const TEMPLATES = [
  {
    kind: 'schedule' as Kind,
    title: 'Morning PR summary',
    text: 'Every weekday at 9:00 AM, start a chat that summarizes open pull requests.',
  },
  {
    kind: 'github' as Kind,
    title: 'Triage new bugs',
    text: 'When an issue is labelled “bug”, start a chat that finds the likely cause.',
  },
  {
    kind: 'webhook' as Kind,
    title: 'Investigate failed deploys',
    text: 'When your CI reports a failed deploy, start a chat that explains what broke.',
  },
];
