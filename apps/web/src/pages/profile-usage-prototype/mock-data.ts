/**
 * Mock profiles and account usage for the profile-usage prototype. Account names and
 * percentages mirror real samples from 2026-11-08; the stress cases (a 5h window at 94%,
 * an account at its limit, a paused account, a 120-char name) are invented.
 */
import type {
  AgentProfile,
  CredentialLimitCredentialSummary,
  CredentialLimitLevel,
  CredentialLimitWindowSummary,
} from '@simple-agent-manager/shared';

import type { ProfileBudget } from '../../components/agent-profiles/useProfileBudgets';

/** Frozen clock so countdowns read the same in every screenshot. */
export const NOW = Date.parse('2026-11-08T16:10:00Z');
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function level(percent: number | null): CredentialLimitLevel {
  if (percent === null) return 'ok';
  if (percent >= 100) return 'rejected';
  if (percent >= 90) return 'critical';
  if (percent >= 75) return 'warning';
  return 'ok';
}

function win(
  windowType: string,
  provider: string,
  utilizationPercent: number | null,
  resetsInMs: number | null,
  windowMinutes: number | null
): CredentialLimitWindowSummary {
  const lvl = level(utilizationPercent);
  return {
    windowType,
    provider,
    source: 'prototype',
    status: lvl === 'rejected' ? 'rejected' : lvl === 'ok' ? 'allowed' : 'allowed_warning',
    level: lvl,
    utilizationPercent,
    limitAmount: null,
    remainingAmount: null,
    windowMinutes,
    resetsAt: resetsInMs === null ? null : NOW + resetsInMs,
    observedAt: NOW - 4 * MIN,
    updatedAt: NOW - 4 * MIN,
  };
}

const claude5h = (pct: number, resetsIn: number) =>
  win('claude.five_hour', 'anthropic', pct, resetsIn, 300);
const claudeWeek = (pct: number, resetsIn: number) =>
  win('claude.seven_day', 'anthropic', pct, resetsIn, 10080);

function account(
  id: string,
  name: string,
  agentType: string,
  provider: string,
  windows: CredentialLimitWindowSummary[],
  source: CredentialLimitCredentialSummary['credentialSource'] = 'user'
): CredentialLimitCredentialSummary {
  const order: CredentialLimitLevel[] = ['ok', 'warning', 'critical', 'rejected'];
  const worst = windows.reduce<CredentialLimitLevel>(
    (acc, w) => (order.indexOf(w.level) > order.indexOf(acc) ? w.level : acc),
    'ok'
  );
  return {
    credentialReference: `cc_credentials:${id}`,
    credentialId: id,
    credentialName: name,
    credentialSource: source,
    provider,
    providerMode: 'direct',
    agentType,
    level: worst,
    observedAt: NOW - 4 * MIN,
    windows,
  };
}

export const ACCOUNTS = {
  samSam: account('sam-sam', 'Sam Sam', 'claude-code', 'anthropic', [
    claude5h(17, 1 * HOUR + 10 * MIN),
    claudeWeek(9, 6 * DAY + 14 * HOUR),
  ]),
  samSupport: account('sam-support', 'Sam Support', 'claude-code', 'anthropic', [
    claude5h(94, 52 * MIN),
    claudeWeek(69, 6 * HOUR + 50 * MIN),
  ]),
  ecClaude: account('ec-claude', 'EC Claude', 'claude-code', 'anthropic', [
    claude5h(0, 4 * HOUR + 20 * MIN),
    claudeWeek(23, 5 * DAY + 13 * HOUR),
  ]),
  samSocial: account('sam-social', 'Sam Social', 'claude-code', 'anthropic', [
    claude5h(100, 2 * HOUR + 10 * MIN),
    claudeWeek(56, 3 * HOUR + 50 * MIN),
  ]),
  samSales: account(
    'sam-sales',
    'Sam Sales',
    'claude-code',
    'anthropic',
    [claude5h(0, 3 * HOUR), claudeWeek(6, 6 * DAY + 13 * HOUR)],
    'project'
  ),
  codex: account('codex', 'OpenAI Codex auth.json', 'openai-codex', 'openai', [
    win('codex.primary', 'openai', 40, 2 * DAY + 14 * HOUR, 10080),
  ]),
  codexWork: account(
    'codex-work',
    'Work ChatGPT Pro — shared with the whole platform team for overnight refactors and reviews',
    'openai-codex',
    'openai',
    [
      win('codex.five_hour', 'openai', 81, 1 * HOUR + 35 * MIN, 300),
      win('codex.primary', 'openai', 62, 4 * DAY, 10080),
    ]
  ),
  opencode: account('opencode', 'OpenCode API key', 'opencode', 'opencode', [
    win('opencode.weekly', 'opencode', 40, 7 * HOUR + 50 * MIN, null),
    win('opencode.monthly', 'opencode', 60, null, null),
  ]),
  unsampled: account('fresh-max', 'Fresh Max', 'claude-code', 'anthropic', []),
} as const;

type AccountKey = keyof typeof ACCOUNTS;

let seq = 0;
function profile(
  name: string,
  agentType: string,
  model: string | null,
  effort: AgentProfile['effort'],
  extra: Partial<AgentProfile> = {}
): AgentProfile {
  seq += 1;
  return {
    id: `p-${seq}`,
    projectId: 'proj-1',
    userId: 'u-1',
    name,
    description: null,
    agentType,
    model,
    effort,
    permissionMode: null,
    systemPromptAppend: null,
    maxTurns: null,
    timeoutMinutes: null,
    vmSizeOverride: null,
    provider: null,
    vmLocation: null,
    workspaceProfile: null,
    runtime: null,
    devcontainerConfigName: null,
    taskMode: 'conversation',
    githubCliPolicy: null,
    agentModels: null,
    isBuiltin: false,
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
    ...extra,
  };
}

/** [profile, which account it resolves to] — the order is the picker's order. */
const ROWS: Array<[AgentProfile, AccountKey | 'platform' | 'none' | 'paused']> = [
  [profile('Astra High', 'openai-codex', 'gpt-6-astra', 'high'), 'codex'],
  [
    profile('OC', 'opencode', 'opencode/kimi-k3', 'auto', {
      description: 'Chat and explore with a lightweight workspace',
    }),
    'opencode',
  ],
  [profile('Opus 5.5 Chat', 'claude-code', 'claude-opus-5-5', 'high'), 'samSupport'],
  [profile('SamSamC', 'claude-code', 'claude-opus-5-5', 'high'), 'samSocial'],
  [profile('Aggie', 'google-antigravity', 'gemini-3.8-flash', 'auto'), 'none'],
  [profile('Claudiii', 'claude-code', 'claude-opus-5-5', 'high'), 'samSam'],
  [profile('Fable chat', 'claude-code', 'claude-fable-5-1', 'xhigh'), 'ecClaude'],
  [profile('Instant', 'openai-codex', 'gpt-6.1-sol', 'xhigh'), 'codex'],
  [profile('Lil Q', 'openai-codex', 'gpt-6-luna', 'medium'), 'codexWork'],
  [profile("MF'in Astra", 'openai-codex', 'gpt-6-astra', 'low'), 'codex'],
  [profile('Sales desk', 'claude-code', 'claude-opus-5-5', 'medium'), 'samSales'],
  [profile('Brand new Max', 'claude-code', 'claude-fable-5-1', 'high'), 'unsampled'],
  [profile('SAM proxy (Gemma)', 'claude-code', null, 'auto'), 'platform'],
  [profile('Paused Claude', 'claude-code', 'claude-opus-5-5', 'max'), 'paused'],
  [
    profile(
      'Extremely long profile name that someone typed without thinking about the phone layout at all ✨',
      'openai-codex',
      'gpt-6-sol',
      'high',
      { taskMode: 'task' }
    ),
    'codexWork',
  ],
  [profile('Backend Implementation', 'openai-codex', 'gpt-6.1-sol', 'high', { taskMode: 'task' }), 'codex'],
  [profile('Frontend Implementation', 'claude-code', 'claude-opus-5-5', 'high', { taskMode: 'task' }), 'samSam'],
  [profile('Reviewer', 'claude-code', 'claude-fable-5-1', 'max', { taskMode: 'task' }), 'samSupport'],
  [profile('Docs writer', 'opencode', 'opencode/kimi-k2.6', 'auto', { taskMode: 'task' }), 'opencode'],
  [profile('Night shift', 'openai-codex', 'gpt-6-luna', 'low', { taskMode: 'task' }), 'codexWork'],
  [profile('X', 'claude-code', 'claude-opus-5-5', 'low', { taskMode: 'task' }), 'ecClaude'],
];

export const PROFILES: AgentProfile[] = ROWS.map(([p]) => p);

export const BUDGETS: ReadonlyMap<string, ProfileBudget> = new Map(
  ROWS.map(([p, key]): [string, ProfileBudget] => {
    if (key === 'platform') return [p.id, { kind: 'platform' }];
    if (key === 'none') return [p.id, { kind: 'none' }];
    if (key === 'paused') return [p.id, { kind: 'paused', label: 'Old Max' }];
    const usage = ACCOUNTS[key];
    return [
      p.id,
      { kind: 'account', label: usage.credentialName ?? 'Account', usage: usage.windows.length ? usage : null },
    ];
  })
);

/** First four are "Recent" in the cards; first three in the sheet. */
export const RECENT_IDS = PROFILES.slice(0, 4).map((p) => p.id);
