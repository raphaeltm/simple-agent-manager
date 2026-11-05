/**
 * Stress-test data for the profile-budget prototype. Shapes mirror the real
 * `AgentProfile` and `CredentialLimitCredentialSummary` read models so the
 * learnings port straight to `ProfileList` + `useAccounts`.
 *
 * NOW is pinned so screenshots are deterministic.
 */
import type { CredentialLimitCredentialSummary, ResourceRequirements } from '@simple-agent-manager/shared';

export const NOW = Date.UTC(2026, 10, 5, 17, 45);
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export interface MockProfile {
  id: string;
  name: string;
  description: string | null;
  agentType: 'claude-code' | 'openai-codex' | 'opencode' | 'google-gemini';
  model: string;
  effort: string | null;
  taskMode: 'conversation' | 'task';
  vmSize: string | null;
  runtime: 'vm' | 'instant';
  permissionMode: string | null;
  /** Explicit resource request on the profile; null = inherit (or legacy `vmSize`). */
  resources: ResourceRequirements | null;
  /** Credential reference this profile resolves to (profile pin → project pin → default → platform). */
  accountRef: string;
  /** Which tier picked the account. */
  accountVia: 'profile pin' | 'project pin' | 'default' | 'platform';
}

function win(
  windowType: string,
  provider: string,
  utilizationPercent: number | null,
  windowMinutes: number | null,
  resetsInMs: number | null,
  sampledAgoMs: number,
  level: 'ok' | 'warning' | 'critical' | 'rejected' = 'ok'
): CredentialLimitCredentialSummary['windows'][number] {
  return {
    windowType,
    provider,
    source: 'mock',
    status: level === 'rejected' ? 'rejected' : level === 'ok' ? 'allowed' : 'allowed_warning',
    level,
    utilizationPercent,
    limitAmount: null,
    remainingAmount: null,
    windowMinutes,
    resetsAt: resetsInMs === null ? null : NOW + resetsInMs,
    observedAt: NOW - sampledAgoMs,
    updatedAt: NOW - sampledAgoMs,
  };
}

function account(
  ref: string,
  name: string | null,
  agentType: string,
  provider: string,
  windows: CredentialLimitCredentialSummary['windows'],
  source: CredentialLimitCredentialSummary['credentialSource'] = 'user'
): CredentialLimitCredentialSummary {
  const levels = ['ok', 'warning', 'critical', 'rejected'] as const;
  const worst = windows.reduce((acc, w) => Math.max(acc, levels.indexOf(w.level)), 0);
  return {
    credentialReference: ref,
    credentialId: ref.split(':')[1] ?? null,
    credentialName: name,
    credentialSource: source,
    provider,
    providerMode: 'oauth',
    agentType,
    level: levels[worst] ?? 'ok',
    observedAt: Math.max(...windows.map((w) => w.observedAt), NOW - DAY),
    windows,
  };
}

export const ACCOUNTS: CredentialLimitCredentialSummary[] = [
  account('cc_credentials:raph-max', 'Raph Max', 'claude-code', 'anthropic', [
    win('claude.five_hour', 'anthropic', 72, 300, 70 * MIN, 4 * MIN),
    win('claude.seven_day', 'anthropic', 31, 10080, 3 * DAY + 4 * HOUR, 4 * MIN),
    win('claude.seven_day_opus', 'anthropic', 88, 10080, 3 * DAY + 4 * HOUR, 4 * MIN, 'warning'),
  ]),
  account('cc_credentials:work-pro', 'Work Pro (ChatGPT)', 'openai-codex', 'openai', [
    win('codex.primary', 'openai', 94, 300, 22 * MIN, 2 * MIN, 'critical'),
    win('codex.secondary', 'openai', 46, 10080, 5 * DAY, 2 * MIN),
  ]),
  // The reset bug: the 5h window was 81% when last sampled 3h ago, but it reset 2h ago.
  account('cc_credentials:codex-team', 'Codex Team seat', 'openai-codex', 'openai', [
    win('codex.primary', 'openai', 81, 300, -2 * HOUR, 3 * HOUR, 'warning'),
    win('codex.secondary', 'openai', 58, 10080, 4 * DAY, 3 * HOUR),
  ]),
  // Rejected window whose reset already passed: still shows "Limit reached" in prod today.
  account('cc_credentials:oc-go', 'OpenCode Go', 'opencode', 'opencode', [
    win('opencode.rolling', 'opencode', 100, null, -40 * MIN, 5 * HOUR, 'rejected'),
    win('opencode.weekly', 'opencode', 62, null, 2 * DAY, 5 * HOUR),
    win('opencode.monthly', 'opencode', 12, null, 19 * DAY, 5 * HOUR),
  ]),
];

/** Accounts with no usage samples at all (API keys, platform). */
export const UNSAMPLED_ACCOUNTS: Record<string, { name: string; note: string }> = {
  'platform_credentials:sam': { name: 'SAM platform', note: 'Billed per token, no plan windows' },
  'cc_credentials:gemini-key': { name: 'Gemini API key', note: 'No usage seen yet' },
};

export const PROFILES: MockProfile[] = [
  {
    id: 'p1',
    name: 'Astra High',
    description: null,
    agentType: 'openai-codex',
    model: 'gpt-6-astra',
    effort: 'high',
    taskMode: 'conversation',
    vmSize: null,
    runtime: 'vm',
    permissionMode: null,
    resources: null,
    accountRef: 'cc_credentials:codex-team',
    accountVia: 'profile pin',
  },
  {
    id: 'p2',
    name: 'Backend Implementation',
    description: 'Write code and open pull requests focused on backend tasks.',
    agentType: 'openai-codex',
    model: 'gpt-6.1-sol',
    effort: 'medium',
    taskMode: 'task',
    vmSize: 'medium',
    runtime: 'vm',
    permissionMode: null,
    resources: null,
    accountRef: 'cc_credentials:work-pro',
    accountVia: 'project pin',
  },
  {
    id: 'p3',
    name: 'Claudiii',
    description: null,
    agentType: 'claude-code',
    model: 'claude-opus-5-5',
    effort: 'high',
    taskMode: 'conversation',
    vmSize: null,
    runtime: 'vm',
    permissionMode: 'bypassPermissions',
    resources: { minVcpu: 4, minMemoryGb: 7.5, minDiskGb: 60 },
    accountRef: 'cc_credentials:raph-max',
    accountVia: 'default',
  },
  {
    id: 'p4',
    name: 'Fable chat',
    description: null,
    agentType: 'claude-code',
    model: 'claude-fable-5-1',
    effort: 'xhigh',
    taskMode: 'conversation',
    vmSize: null,
    runtime: 'vm',
    permissionMode: null,
    resources: null,
    accountRef: 'cc_credentials:raph-max',
    accountVia: 'default',
  },
  {
    id: 'p5',
    name: 'Frontend Implementation',
    description: null,
    agentType: 'claude-code',
    model: 'claude-opus-5-5',
    effort: null,
    taskMode: 'task',
    vmSize: 'medium',
    runtime: 'vm',
    permissionMode: null,
    resources: null,
    accountRef: 'cc_credentials:raph-max',
    accountVia: 'default',
  },
  {
    id: 'p6',
    name: 'Instant',
    description: 'Chat and explore with a lightweight workspace',
    agentType: 'openai-codex',
    model: 'gpt-6.1-sol',
    effort: 'xhigh',
    taskMode: 'conversation',
    vmSize: null,
    runtime: 'instant',
    permissionMode: null,
    resources: null,
    accountRef: 'cc_credentials:work-pro',
    accountVia: 'project pin',
  },
  {
    id: 'p7',
    name: 'Lil Q',
    description: 'Chat and explore with a lightweight workspace',
    agentType: 'openai-codex',
    model: 'gpt-6-luna',
    effort: 'medium',
    taskMode: 'conversation',
    vmSize: 'medium',
    runtime: 'vm',
    permissionMode: null,
    resources: null,
    accountRef: 'cc_credentials:work-pro',
    accountVia: 'project pin',
  },
  {
    id: 'p8',
    name: "MF'in Astra",
    description: 'Chat and explore with a lightweight workspace',
    agentType: 'openai-codex',
    model: 'gpt-6-astra',
    effort: 'low',
    taskMode: 'conversation',
    vmSize: null,
    runtime: 'vm',
    permissionMode: null,
    resources: { minVcpu: 1, minMemoryGb: 2 },
    accountRef: 'cc_credentials:codex-team',
    accountVia: 'profile pin',
  },
  {
    id: 'p9',
    name: 'OC',
    description: 'Chat and explore with a lightweight workspace',
    agentType: 'opencode',
    model: 'kimi-k2.5',
    effort: null,
    taskMode: 'conversation',
    vmSize: null,
    runtime: 'instant',
    permissionMode: null,
    resources: null,
    accountRef: 'cc_credentials:oc-go',
    accountVia: 'default',
  },
  {
    id: 'p10',
    name: 'Extremely Long Profile Name For The Overnight Migration Reviewer That Nobody Shortened',
    description:
      'Reviews every data migration with an adversarial mindset, cross-checks the rollback path, and writes a long report that nobody will read on a phone.',
    agentType: 'google-gemini',
    model: 'gemini-3.5-pro-preview-2026-10-experimental',
    effort: 'max',
    taskMode: 'task',
    vmSize: 'large',
    runtime: 'vm',
    permissionMode: null,
    resources: { minVcpu: 8, minMemoryGb: 15.5, minDiskGb: 160, exclusiveNode: true },
    accountRef: 'cc_credentials:gemini-key',
    accountVia: 'default',
  },
  {
    id: 'p11',
    name: 'SAM Gemma',
    description: null,
    agentType: 'opencode',
    model: 'gemma-4-27b',
    effort: null,
    taskMode: 'conversation',
    vmSize: null,
    runtime: 'instant',
    permissionMode: null,
    resources: null,
    accountRef: 'platform_credentials:sam',
    accountVia: 'platform',
  },
];
