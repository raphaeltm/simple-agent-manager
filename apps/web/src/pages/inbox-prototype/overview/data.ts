/**
 * PROTOTYPE ONLY — the one mock project behind /prototype/project-overview (idea
 * 01M7G03ZCQ6TM6CMEYDRKQ8ST9, section 11). Acme Billing in three states. Every count on a
 * tile is derived from these arrays and from the inbox data, so the tiles, the brief and the
 * inbox cannot disagree.
 */
import type {
  AgentProfile,
  IdeaListItem,
  ProjectSchedule,
  TriggerResponse,
} from '@simple-agent-manager/shared';

import type { ProfileUsage } from '../../../components/project-chat/profile-picker';
import {
  healthColor,
  type UsageWindowReading,
} from '../../../components/project-chat/profile-picker/usage-windows';
import type { ChatSessionResponse } from '../../../lib/api';
import type { AutomationItem } from '../../automation/model';
import { must } from '../mock-data';

export const PROJECT_NAME = 'Acme Billing';
export const PROJECT_ID = 'proj-proto';
export type ProjectState = 'normal' | 'quiet' | 'busy';

const MIN = 60_000;
const now = Date.now();

// ── Profiles and the accounts they run on ──────────────────────────────────────────────

function profile(
  id: string,
  name: string,
  agentType: string,
  model: string,
  description: string
): AgentProfile {
  return {
    id,
    projectId: PROJECT_ID,
    userId: 'user-you',
    name,
    description,
    agentType,
    model,
    effort: 'auto',
    permissionMode: null,
    systemPromptAppend: null,
    maxTurns: null,
    timeoutMinutes: null,
    vmSizeOverride: null,
    workspaceProfile: null,
    runtime: null,
    devcontainerConfigName: null,
    taskMode: 'task',
    githubCliPolicy: null,
    agentModels: null,
    isBuiltin: false,
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-11-01T00:00:00Z',
  } as AgentProfile;
}

export const PROFILES: AgentProfile[] = [
  profile('p-opus', 'Opus 5.5 Build', 'claude-code', 'claude-opus-5-5', 'Builds and opens PRs'),
  profile('p-sonnet', 'Sonnet 5.5 Chat', 'claude-code', 'claude-sonnet-5-5', 'Chat and explore'),
  profile('p-codex', 'Codex Build', 'openai-codex', 'gpt-5.3-codex', 'Builds and opens PRs'),
  profile('p-kimi', 'Kimi K3 Review', 'opencode', 'kimi-k3', 'Reviews PRs'),
];

const profileById = (id: string) => must(PROFILES.find((p) => p.id === id) ?? PROFILES[0]);

function reading(label: '5h' | 'Week', left: number, resetIn: string): UsageWindowReading {
  return {
    windowType: label === '5h' ? 'five_hour' : 'seven_day',
    label,
    shortLabel: label === '5h' ? '5h' : 'Wk',
    left,
    refused: left === 0,
    resetIn,
    minutes: label === '5h' ? 300 : 10_080,
    resetElapsed: false,
  };
}

/** A usage reading shaped exactly like `profileUsage()` builds it from a credential. */
function usage(
  label: string,
  session: number,
  week: number,
  resets: [string, string]
): ProfileUsage {
  const s = reading('5h', session, resets[0]);
  const w = reading('Week', week, resets[1]);
  const left = Math.min(session, week);
  return {
    state: left === 0 ? 'out' : session <= 50 || week <= 50 ? 'low' : 'ok',
    left,
    color: healthColor(week),
    resetIn: session < week ? resets[0] : resets[1],
    accountLabel: label,
    accountKey: `cred-${label}`,
    accountId: `acct-${label}`,
    session: s,
    week: w,
    windows: [s, w],
    urgent: session < 25 || week < 25,
  };
}

export interface Account {
  label: string;
  /** The profile whose glyph sits inside the ring. */
  profile: AgentProfile;
  profiles: string[];
  usage: ProfileUsage;
}

function accounts(state: ProjectState): Account[] {
  return [
    {
      label: 'Personal Max',
      profile: profileById('p-opus'),
      profiles: ['Opus 5.5 Build', 'Sonnet 5.5 Chat'],
      usage:
        state === 'busy'
          ? usage('Personal Max', 41, 6, ['1h 50m', '2d 4h'])
          : usage('Personal Max', state === 'quiet' ? 96 : 64, state === 'quiet' ? 82 : 71, [
              '3h 05m',
              '4d 2h',
            ]),
    },
    {
      label: 'Work Pro',
      profile: profileById('p-codex'),
      profiles: ['Codex Build'],
      usage: usage('Work Pro', state === 'quiet' ? 100 : 38, state === 'busy' ? 33 : 58, [
        '1h 20m',
        '3d 6h',
      ]),
    },
    {
      label: 'OpenCode Go',
      profile: profileById('p-kimi'),
      profiles: ['Kimi K3 Review'],
      usage: usage('OpenCode Go', 92, 88, ['4h 10m', '5d 1h']),
    },
  ];
}

// ── Running chats ──────────────────────────────────────────────────────────────────────

export interface RunningChat {
  session: ChatSessionResponse;
  profile: string;
  /** Minutes since it started. */
  runningMin: number;
  /** Paused on an inbox item in this project (the reason it waits). */
  pausedOn: string | null;
}

function chat(
  id: string,
  topic: string,
  profileName: string,
  runningMin: number,
  pausedOn: string | null,
  lastMin: number
): RunningChat {
  return {
    profile: profileName,
    runningMin,
    pausedOn,
    session: {
      id,
      workspaceId: `ws-${id}`,
      taskId: `task-${id}`,
      isMine: true,
      topic,
      status: 'active',
      messageCount: 24,
      startedAt: now - runningMin * MIN,
      endedAt: null,
      createdAt: now - runningMin * MIN,
      lastMessageAt: now - lastMin * MIN,
      task: { id: `task-${id}`, status: 'in_progress', taskMode: 'task' },
      attention: pausedOn
        ? { markerId: pausedOn, kind: 'needs_input', createdAt: now - lastMin * MIN }
        : undefined,
    } as ChatSessionResponse,
  };
}

const NORMAL_RUNNING: RunningChat[] = [
  chat('s-ship', 'Ship billing', 'Opus 5.5 Build', 70, 'q-vat', 12),
  chat('s-invoice', 'Invoice PDF export', 'Sonnet 5.5 Chat', 8, 'perm-migrate', 3),
  chat('s-cleanup', 'Clean up staging', 'Sonnet 5.5 Chat', 41, 'approval-ws', 40),
  chat('s-dunning', 'Dunning emails for failed renewals', 'Codex Build', 42, null, 1),
  chat('s-rounding', 'Fix rounding in tax totals', 'Opus 5.5 Build', 12, null, 0),
];

const LONG_TOPIC =
  'Migrate every remaining hand-rolled invoice loader to the new ledger API and prove nothing double-counts refunds across currency conversions';

const BUSY_RUNNING: RunningChat[] = [
  chat('s-b1', LONG_TOPIC, 'Opus 5.5 Build', 190, 'busy-1', 30),
  ...NORMAL_RUNNING,
  chat('s-b2', 'Backfill tax IDs for 2,400 EU customers', 'Codex Build', 64, null, 2),
  chat('s-b3', 'Chargeback webhook retries', 'Opus 5.5 Build', 33, null, 1),
  chat('s-b4', 'Customer portal: download all invoices as a zip', 'Sonnet 5.5 Chat', 27, null, 4),
  chat('s-b5', 'Review PR #92 (proration)', 'Kimi K3 Review', 9, null, 1),
  chat('s-b6', 'Currency rounding audit', 'Codex Build', 51, null, 6),
  chat('s-b7', 'Load test checkout at 200 rps', 'Opus 5.5 Build', 15, null, 0),
];

/** A task started from the Overview's composer: running, no chat opened. */
export function startedChat(title: string, profileName: string): RunningChat {
  return chat(`s-new-${title.length}`, title, profileName, 0, null, 0);
}

// ── Automations (the Automation page's own view model) ─────────────────────────────────

function automation(
  over: Partial<AutomationItem> & Pick<AutomationItem, 'id' | 'name'>
): AutomationItem {
  return {
    kind: 'trigger',
    trigger: { id: over.id, githubConfig: null } as unknown as TriggerResponse,
    start: 'github',
    when: 'When an issue is opened',
    action: { kind: 'start', prompt: '', agentProfileId: 'p-sonnet', skillId: null },
    state: 'on',
    nextAt: null,
    lastRunAt: now - 300 * MIN,
    createdAt: now - 30 * 1440 * MIN,
    createdBy: 'user-you',
    attention: null,
    ...over,
  } as AutomationItem;
}

const NIGHTLY = automation({
  kind: 'schedule',
  schedule: { id: 'a-nightly' } as unknown as ProjectSchedule,
  id: 'a-nightly',
  name: 'Nightly invoice reconciliation',
  start: 'schedule',
  when: 'Every day at 2:00 AM',
  nextAt: now + 6 * 60 * MIN,
} as Partial<AutomationItem> & { id: string; name: string });

const TRIAGE_FAILING = automation({
  id: 'a-triage',
  name: 'Triage new GitHub issues',
  state: 'paused',
  stateNote: 'Paused after 3 failed runs',
  attention: {
    tone: 'danger',
    title: 'Paused after 3 failed runs in a row',
    body: 'Each run stopped at “clone repository”: the GitHub App no longer has access to acme/billing.',
    fix: 'resume',
    at: now - 50 * MIN,
  },
});

const WEBHOOK_FAILING = automation({
  id: 'a-stripe-hook',
  name: 'When Stripe reports a disputed charge, start a chat with Opus 5.5 Build to gather evidence and draft the response',
  start: 'webhook',
  when: 'When the Stripe webhook is called',
  state: 'on',
  attention: {
    tone: 'warning',
    title: 'Its last 2 runs ended without a result',
    body: 'The webhook arrived, but the chat stopped before replying. Check what happened before the next dispute.',
    fix: 'review-runs',
    at: now - 20 * MIN,
  },
});

export interface AutomationSummary {
  total: number;
  items: AutomationItem[];
}

function automations(state: ProjectState): AutomationSummary {
  if (state === 'quiet') return { total: 3, items: [NIGHTLY] };
  if (state === 'busy') return { total: 9, items: [NIGHTLY, TRIAGE_FAILING, WEBHOOK_FAILING] };
  return { total: 5, items: [NIGHTLY, TRIAGE_FAILING] };
}

// ── Recently: ideas and merged PRs ─────────────────────────────────────────────────────

function idea(
  ideaId: string,
  title: string,
  derivedState: IdeaListItem['derived']['state'],
  extra: Partial<IdeaListItem['derived']> = {},
  summary: string | null = null
): IdeaListItem {
  return {
    ideaId,
    title,
    summary,
    createdAt: new Date(now - 1440 * MIN).toISOString(),
    updatedAt: new Date(now - 30 * MIN).toISOString(),
    derived: {
      state: derivedState,
      needsYou: null,
      source: { origin: 'chat', observedAt: new Date(now - 5 * MIN).toISOString(), stale: false },
      session: null,
      pullRequest: null,
      note: null,
      ...extra,
    },
    counts: { updates: 3, chats: 1, files: 0, pullRequests: 0, atLeast: [] },
    filedByAgent: false,
    filedBy: null,
    viaConnector: null,
  };
}

export const IDEAS: IdeaListItem[] = [
  idea('i-dunning', 'Dunning emails for failed renewals', 'working', {
    session: {
      sessionId: 's-dunning',
      topic: 'Dunning emails for failed renewals',
      sessionStatus: 'active',
      taskId: 'task-s-dunning',
      taskStatus: 'in_progress',
      agentLabel: 'Codex Build',
      lastActivityAt: new Date(now - MIN).toISOString(),
    },
  }),
  idea('i-pdf', 'Invoice PDF links in receipt emails', 'review', {
    pullRequest: {
      url: 'https://github.com/acme/billing/pull/91',
      number: 91,
      source: 'task_output',
      state: 'open',
      isDraft: true,
      title: 'Invoice PDF export',
      checksState: 'pending',
      mergedAt: null,
      updatedAt: null,
      stale: false,
    },
  }),
  idea(
    'i-usage',
    'Usage-based pricing for the Pro plan',
    'not-started',
    {},
    'Charge per invoice above 500 a month; keep Starter flat.'
  ),
];

export interface MergedPr {
  number: number;
  title: string;
  chat: string;
  ageMin: number;
}

const MERGED_PRS: MergedPr[] = [
  { number: 88, title: 'Trial logic for Starter', chat: 'Ship billing', ageMin: 50 },
  { number: 86, title: 'Stripe webhooks with signature check', chat: 'Ship billing', ageMin: 420 },
  { number: 85, title: 'Plans table and price IDs', chat: 'Ship billing', ageMin: 1500 },
];

// ── The project in one state ───────────────────────────────────────────────────────────

export interface ProjectData {
  state: ProjectState;
  inboxDataset: 'base' | 'empty' | 'busy';
  running: RunningChat[];
  accounts: Account[];
  automations: AutomationSummary;
  mergedPrs: MergedPr[];
}

export function projectData(state: ProjectState): ProjectData {
  return {
    state,
    inboxDataset: state === 'quiet' ? 'empty' : state === 'busy' ? 'busy' : 'base',
    running: state === 'quiet' ? [] : state === 'busy' ? BUSY_RUNNING : NORMAL_RUNNING,
    accounts: accounts(state),
    automations: automations(state),
    mergedPrs:
      state === 'quiet'
        ? [
            {
              number: 90,
              title: 'Pricing page rewrite',
              chat: 'Pricing page rewrite',
              ageMin: 300,
            },
            ...MERGED_PRS.slice(0, 2),
          ]
        : MERGED_PRS,
  };
}
