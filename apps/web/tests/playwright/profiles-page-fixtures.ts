/**
 * The project Profiles page's mocked API, shared by `profiles-ui-audit.spec.ts` (stress cases)
 * and `docs-screenshots-profiles.spec.ts` (the documentation image). Account rows come from the
 * unit-test fixtures, so which account a profile resolves to is computed by the real account
 * model and shared resolver.
 */
import type { Page } from '@playwright/test';
import type { CCProfileAttachmentItem } from '@simple-agent-manager/shared';

import { accountRows, mergeRows } from '../unit/components/accounts/fixtures';
import { type AuditResponder, makeMockUser, setupAuditRoutes } from './audit-helpers';
import { credentialUsage as usage, limitWindow } from './credential-limit-fixtures';
import { makeAgentProfile, respondToProfilePageRoute } from './profile-account-fixtures';

export const USER = makeMockUser({
  email: 'raphael@example.com',
  name: 'Raphaël',
  sessionId: 'session-profiles-list',
  userId: 'user-profiles-list',
});

export const PROJECTS = [{ id: 'p-web', name: 'Marketing site' }];
export const NOW = Date.now();
export const HOUR = 3_600_000;
export type Profile = ReturnType<typeof makeAgentProfile>;

export function profile(
  id: string,
  name: string,
  overrides: Record<string, unknown> = {}
): Profile {
  return { ...makeAgentProfile(id, name, 'p-web', USER.user.id), ...overrides } as Profile;
}

export const NORMAL: Profile[] = [
  profile('astra', 'Astra High', {
    agentType: 'openai-codex',
    model: 'gpt-6-astra',
    effort: 'high',
    taskMode: 'conversation',
  }),
  profile('backend', 'Backend Implementation', {
    description: 'Write code and open pull requests focused on backend tasks.',
    agentType: 'openai-codex',
    model: 'gpt-6.1-sol',
    effort: 'medium',
    vmSizeOverride: 'medium',
    taskMode: 'task',
  }),
  profile('claudiii', 'Claudiii', {
    model: 'claude-opus-5-5',
    effort: 'high',
    permissionMode: 'bypassPermissions',
    resourceRequirementsJson: JSON.stringify({ minVcpu: 4, minMemoryGb: 7.5, minDiskGb: 60 }),
  }),
  profile('fable', 'Fable chat', {
    model: 'claude-fable-5-1',
    effort: 'xhigh',
    taskMode: 'conversation',
  }),
  profile('instant', 'Instant', {
    description: 'Chat and explore with a lightweight workspace',
    agentType: 'openai-codex',
    model: 'gpt-6.1-sol',
    effort: 'xhigh',
    runtime: 'cf-container',
    taskMode: 'conversation',
  }),
  profile('oc', 'OC', { agentType: 'opencode', model: 'kimi-k2.5', runtime: 'cf-container' }),
];

const ROWS = mergeRows(
  accountRows({
    id: 'max',
    name: 'Raph Max',
    kind: 'agent',
    target: 'claude-code',
    credentialKind: 'oauth-token',
    isDefault: true,
  }),
  accountRows({
    id: 'work',
    name: 'Work Pro (ChatGPT)',
    kind: 'agent',
    target: 'openai-codex',
    credentialKind: 'oauth-token',
    isDefault: true,
  }),
  accountRows({
    id: 'team',
    name: 'Codex Team seat',
    kind: 'agent',
    target: 'openai-codex',
    credentialKind: 'oauth-token',
  })
);

const PINS: CCProfileAttachmentItem[] = [
  {
    id: 'pin-astra',
    configurationId: 'cfg-team',
    agentProfileId: 'astra',
    profileName: 'Astra High',
    projectId: 'p-web',
    projectName: 'Marketing site',
    consumerKind: 'agent',
    consumerTarget: 'openai-codex',
    isActive: true,
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
  },
];

const LIMITS = [
  usage('cred-max', 'claude-code', [
    limitWindow('claude.five_hour', 72),
    limitWindow('claude.seven_day', 31),
    limitWindow('claude.seven_day_opus', 88, { level: 'warning', status: 'allowed_warning' }),
  ]),
  usage('cred-work', 'openai-codex', [
    limitWindow('codex.primary', 94, { level: 'critical', status: 'allowed_warning' }),
    limitWindow('codex.secondary', 46),
  ]),
  // The 5h window was 81% when sampled three hours ago and reset two hours ago.
  usage('cred-team', 'openai-codex', [
    limitWindow('codex.primary', 81, {
      level: 'warning',
      status: 'allowed_warning',
      resetsAt: NOW - 2 * HOUR,
      observedAt: NOW - 3 * HOUR,
    }),
    limitWindow('codex.secondary', 58, { observedAt: NOW - 3 * HOUR }),
  ]),
];

export interface Scenario {
  profiles: Profile[];
  failProfiles?: boolean;
  /** Signed-in user and project list; default to the audit's. */
  user?: typeof USER;
  projects?: { id: string; name: string }[];
}

function handler(scenario: Scenario) {
  return (path: string, respond: AuditResponder): Promise<void> | undefined => {
    if (path === '/api/cc/credentials') return respond(200, { credentials: ROWS.credentials });
    if (path === '/api/cc/configurations') {
      return respond(200, { configurations: ROWS.configurations });
    }
    if (path === '/api/cc/attachments') return respond(200, { attachments: ROWS.attachments });
    if (path === '/api/cc/profile-attachments') return respond(200, { attachments: PINS });
    if (path === '/api/credentials/resolution-status') return respond(200, { consumers: [] });
    if (path === '/api/credentials/limits') {
      return respond(200, { credentials: LIMITS, generatedAt: NOW });
    }
    if (scenario.failProfiles && /^\/api\/projects\/[^/]+\/agent-profiles$/.test(path)) {
      return respond(500, { error: 'INTERNAL_ERROR', message: 'Server error' });
    }
    return respondToProfilePageRoute(path, respond, {
      user: scenario.user ?? USER,
      projects: scenario.projects ?? PROJECTS,
      profiles: scenario.profiles,
    });
  };
}

export async function openProfiles(page: Page, scenario: Scenario) {
  await page.addInitScript(
    (userId) => {
      window.localStorage.setItem(`sam-onboarding-wizard-dismissed-${userId}`, 'true');
    },
    (scenario.user ?? USER).user.id
  );
  await setupAuditRoutes(page, handler(scenario));
  await page.goto('/projects/p-web/profiles');
}
