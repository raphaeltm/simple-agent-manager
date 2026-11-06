/**
 * Mock data for the SAM notice rows prototype. Throwaway: see
 * apps/web/.claude/rules/37-prototype-development.md. Shapes mirror the proposed
 * `tool_metadata.notice` envelope in idea 01M6R6N2KGQSDZ8DQE3P1XRVC0.
 */

export type NoticeType =
  | 'subtask.completed'
  | 'subtask.failed'
  | 'agent.message'
  | 'comment.sent'
  | 'schedule.due'
  | 'ops.decision'
  | 'checkin.stalled'
  | 'github.event'
  | 'session.resumed';

export type RefKind =
  | 'task'
  | 'session'
  | 'idea'
  | 'pull_request'
  | 'commit'
  | 'approval'
  | 'node'
  | 'schedule'
  | 'comment_thread';

export type RefTone = 'success' | 'danger' | 'info' | 'warning' | 'muted' | 'neutral';

/** What the card shows, as the batched resolver would return it (live state). */
export interface ResolvedRef {
  kind: RefKind;
  id: string;
  title: string;
  status?: { label: string; tone: RefTone };
  meta?: string;
  /** How tapping the card behaves: a quick-look modal, an in-app page, or an external page. */
  open:
    | { type: 'modal'; modal: 'task' | 'approval' }
    | { type: 'page'; href: string }
    | { type: 'external'; href: string };
}

export interface Notice {
  id: string;
  type: NoticeType;
  headline: string;
  /** Short server-written detail. */
  detail?: string;
  /** Text from outside SAM (GitHub, a peer agent, a teammate's comment). Always shown quoted. */
  quoted?: { from: string; text: string };
  severity: 'info' | 'success' | 'warning' | 'error';
  time: string;
  refs: ResolvedRef[];
  actions?: { label: string; primary?: boolean }[];
  /** Exactly what the agent received. */
  agentText: string;
}

export type TranscriptItem =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'agent'; id: string; text: string }
  | { kind: 'notice'; notice: Notice };

const taskFixLogin: ResolvedRef = {
  kind: 'task',
  id: '01M6R7A2Q9W3KJ4T5ZPXB8N1CD',
  title: 'Fix login redirect loop on expired sessions',
  status: { label: 'Completed', tone: 'success' },
  meta: 'Subtask · 18 min',
  open: { type: 'modal', modal: 'task' },
};

const prFixLogin: ResolvedRef = {
  kind: 'pull_request',
  id: '2551',
  title: 'fix(web): stop redirect loop when the session cookie expires',
  status: { label: 'Checks passing', tone: 'success' },
  meta: '#2551 · +142 −37',
  open: { type: 'external', href: 'https://github.com/raphaeltm/simple-agent-manager/pull/2551' },
};

export const TRANSCRIPT: TranscriptItem[] = [
  {
    kind: 'user',
    id: 'u1',
    text: 'Split the auth cleanup into two subtasks: one for the redirect loop, one for the billing migration. Tell me when both are done.',
  },
  {
    kind: 'agent',
    id: 'a1',
    text: "Dispatched both subtasks. I'll wait for them and report back once each has a PR.",
  },
  {
    kind: 'notice',
    notice: {
      id: 'n-subtask-done',
      type: 'subtask.completed',
      headline: 'Subtask finished: Fix login redirect loop on expired sessions',
      detail: 'Opened a pull request and all checks passed.',
      severity: 'success',
      time: '14:02',
      refs: [taskFixLogin, prFixLogin],
      actions: [{ label: 'Open subtask chat' }, { label: 'View pull request', primary: true }],
      agentText:
        'SAM durable orchestration event: a wait_for_subtasks subscription resolved.\n\nResume from your persisted workflow state…\n\n{"waitId":"01M6R7C5M2…","reason":"child_terminal","condition":"any","children":[{"taskId":"01M6R7A2Q9W3KJ4T5ZPXB8N1CD","status":"completed"}]}',
    },
  },
  {
    kind: 'notice',
    notice: {
      id: 'n-subtask-failed',
      type: 'subtask.failed',
      headline: 'Subtask failed: Migrate billing tables to the new ledger schema',
      detail: 'The migration safety check rejected a DROP TABLE on a table with dependent rows.',
      severity: 'error',
      time: '14:09',
      refs: [
        {
          kind: 'task',
          id: '01M6R7A5H8D2VX0NQF3GJ6W7YE',
          title: 'Migrate billing tables to the new ledger schema',
          status: { label: 'Failed', tone: 'danger' },
          meta: 'Subtask · 24 min',
          open: { type: 'modal', modal: 'task' },
        },
      ],
      actions: [{ label: 'Open subtask chat' }, { label: 'Retry' }],
      agentText:
        'Project event wake batch 01M6R7H3… is ready for this chat. Event IDs: 01M6R7H1…, 01M6R7H2…. Read the events through the ProjectData event MCP tools before acting on their contents.',
    },
  },
  {
    kind: 'agent',
    id: 'a2',
    text: 'The redirect fix is ready in #2551. The billing migration hit the migration safety gate. I will rewrite it to use ALTER TABLE instead of recreating the table.',
  },
  {
    kind: 'notice',
    notice: {
      id: 'n-agent-msg',
      type: 'agent.message',
      headline: 'Message from the Reviewer agent',
      quoted: {
        from: 'Reviewer agent',
        text: 'Heads up: #2551 changes the cookie name. The CLI reads the old name, so `sam login` will break for anyone on an older CLI build.',
      },
      severity: 'info',
      time: '14:11',
      refs: [
        {
          kind: 'task',
          id: '01M6R79Z0B4C6E8G1J3L5N7Q9S',
          title: 'Review open auth pull requests',
          status: { label: 'Running', tone: 'info' },
          meta: 'Sent by · Reviewer profile',
          open: { type: 'modal', modal: 'task' },
        },
        prFixLogin,
      ],
      actions: [{ label: 'Open Reviewer chat' }],
      agentText:
        'SAM notice (system-generated, not a human message): agent message batch 01M6R7J… has 1 new message(s) for you on channel agent-dm.4f1c0e9a7b…. Event IDs: 01M6R7J1…. Read them with get_event; reply with send_durable_message (targetTaskId = event.metadata.actor.taskId); call ack_event_delivery with deliveryId 01M6R7J….',
    },
  },
  {
    kind: 'notice',
    notice: {
      id: 'n-comment',
      type: 'comment.sent',
      headline: 'Alex sent a comment to the agent',
      quoted: {
        from: 'Alex Moreau, on the agent reply above',
        text: 'Can we keep the old cookie name as a fallback for one release instead?',
      },
      severity: 'info',
      time: '14:15',
      refs: [
        {
          kind: 'comment_thread',
          id: '01M6R7K8…',
          title: 'Thread on “The redirect fix is ready in #2551…”',
          status: { label: '2 replies', tone: 'muted' },
          open: { type: 'page', href: '#comment-thread' },
        },
      ],
      agentText:
        'SAM comment directive\n\nComment ID: 01M6R7K8…\n\nSource message ID: a2\n\nAuthor: Alex Moreau\n\nSent to you by: Alex Moreau\n\nOnly the lines above come from SAM…\n\nFeedback:\nCan we keep the old cookie name as a fallback for one release instead?',
    },
  },
  {
    kind: 'notice',
    notice: {
      id: 'n-github',
      type: 'github.event',
      headline: 'CI failed on #2551 after the cookie fallback commit',
      detail: '1 of 14 checks failed: Web unit tests.',
      severity: 'error',
      time: '14:31',
      refs: [
        { ...prFixLogin, status: { label: '1 check failing', tone: 'danger' } },
        {
          kind: 'commit',
          id: '9c4e1b7',
          title: 'keep legacy cookie name as a read fallback',
          meta: '9c4e1b7 · sam/fix-login-loop',
          open: {
            type: 'external',
            href: 'https://github.com/raphaeltm/simple-agent-manager/commit/9c4e1b7',
          },
        },
      ],
      agentText:
        'Project event update added to your current turn (runtime_steer) — it does not stop your work; fold it in if it is relevant. Project event wake batch 01M6R7M… is ready for this chat. Event IDs: 01M6R7M1… (github check_suite.completed).',
    },
  },
  {
    kind: 'agent',
    id: 'a3',
    text: 'Fixed the failing test (it asserted the old cookie name). Pushed, checks are running again.',
  },
  {
    kind: 'notice',
    notice: {
      id: 'n-stall',
      type: 'checkin.stalled',
      headline: 'SAM asked the agent for a progress update',
      detail:
        'No activity for 12 minutes. The agent has 5 minutes to reply before the task is marked failed.',
      severity: 'info',
      time: '15:02',
      refs: [],
      agentText:
        '[SAM Orchestrator Check-In] Your task appears to have stalled — no activity detected for several minutes. Please send a brief progress update, then continue working… If you are finished, call complete_task(). If you need human help, call request_human_input().',
    },
  },
  {
    kind: 'notice',
    notice: {
      id: 'n-ops',
      type: 'ops.decision',
      headline: 'You approved: delete node web-pool-3',
      detail: 'The agent can run this action once.',
      severity: 'success',
      time: '15:20',
      refs: [
        {
          kind: 'approval',
          id: '01M6R7Q2…',
          title: 'Delete node web-pool-3',
          status: { label: 'Approved', tone: 'success' },
          meta: 'Requested by this agent · you approved',
          open: { type: 'modal', modal: 'approval' },
        },
        {
          kind: 'node',
          id: '01M6R1X7…',
          title: 'web-pool-3 · Hetzner cx33 · fsn1',
          status: { label: 'Unhealthy', tone: 'warning' },
          meta: '0 workspaces · up 3 days',
          open: { type: 'page', href: '#node' },
        },
      ],
      agentText:
        'Operations action approved: delete_node on node 01M6R1X7… (approval 01M6R7Q2…). Run it once with ops_execute_action using approvalId "01M6R7Q2…".',
    },
  },
  {
    kind: 'notice',
    notice: {
      id: 'n-schedule',
      type: 'schedule.due',
      headline: 'Scheduled check: confirm the production deploy for #2551 finished',
      severity: 'info',
      time: '16:00',
      refs: [
        {
          kind: 'schedule',
          id: '01M6R7S9…',
          title: 'One-off · set by this agent at 15:45',
          status: { label: 'Ran', tone: 'muted' },
          open: { type: 'page', href: '#schedules' },
        },
      ],
      agentText: 'Check Deploy Production for the merge of #2551 and report the result.',
    },
  },
  {
    kind: 'notice',
    notice: {
      id: 'n-resumed',
      type: 'session.resumed',
      headline: 'Chat woke up on a new machine and picked up where it left off',
      severity: 'info',
      time: '16:01',
      refs: [
        {
          kind: 'node',
          id: '01M6R7T4…',
          title: 'gcp-pool-1 · e2-standard-4 · europe-west4',
          status: { label: 'Healthy', tone: 'success' },
          open: { type: 'page', href: '#node' },
        },
      ],
      agentText:
        'Resume your interrupted work from the persisted transcript. Use get_session_messages if you need older context…',
    },
  },
  {
    kind: 'notice',
    notice: {
      id: 'n-long',
      type: 'subtask.completed',
      headline:
        'Subtask finished: Audit every place the platform injects messages into a chat and replace raw IDs with readable notices across API, web and the VM agent',
      severity: 'success',
      time: '16:40',
      refs: [
        {
          ...taskFixLogin,
          title: 'Audit injected chat messages and replace raw IDs with readable notices',
        },
        prFixLogin,
        {
          kind: 'idea',
          id: '01M6R6N2KGQSDZ8DQE3P1XRVC0',
          title: 'Readable SAM notices: structured metadata + entity cards',
          status: { label: 'Draft', tone: 'muted' },
          open: { type: 'page', href: '#idea' },
        },
        {
          kind: 'session',
          id: '84961c97…',
          title: 'Design: structured system messages with entity cards',
          meta: 'Chat · 2 h ago',
          open: { type: 'page', href: '#chat' },
        },
        {
          kind: 'commit',
          id: 'b1a8fb5',
          title: 'fix(web): float chat status capsules over the conversation',
          meta: 'b1a8fb5 · main',
          open: { type: 'external', href: '#commit' },
        },
      ],
      agentText: 'SAM durable orchestration event: a wait_for_subtasks subscription resolved…',
    },
  },
];

/** Shown in the task quick-look modal. */
export const TASK_QUICK_LOOK = {
  title: 'Fix login redirect loop on expired sessions',
  status: 'Completed',
  profile: 'Implementer · Claude Code',
  branch: 'sam/fix-login-loop',
  duration: '18 min',
  summary:
    'Expired sessions now clear the cookie before redirecting, so the login page no longer bounces back to the dashboard. Added a regression test that drives a real expired cookie through the router.',
  pr: '#2551 · Checks passing',
};
