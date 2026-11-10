/**
 * Documentation screenshots for a project's Profiles page (Agents guide, "Agent Profiles"):
 * each profile's model, what it asks for, and the usage of the account it runs on.
 *
 * Mocks follow `profiles-ui-audit.spec.ts`, which holds the stress cases; these fixtures are
 * ordinary and fictional on purpose. Account rows come from the unit-test fixtures, so which
 * account a profile resolves to is computed by the real account model and shared resolver.
 *
 * Write the committed images with:
 *   DOCS_SHOTS=1 npx playwright test docs-screenshots-profiles \
 *     --project="Desktop (1280x800)" --project="iPhone SE (375x667)"
 */
import { expect, type Page, test } from '@playwright/test';
import type {
  CCProfileAttachmentItem,
  CredentialLimitCredentialSummary,
  CredentialLimitWindowSummary,
} from '@simple-agent-manager/shared';

import { accountRows, mergeRows } from '../unit/components/accounts/fixtures';
import {
  assertNoOverflow,
  type AuditResponder,
  makeMockUser,
  setupAuditRoutes,
} from './audit-helpers';
import { docsShot } from './docs-shot';
import { makeAgentProfile, respondToProfilePageRoute } from './profile-account-fixtures';

const USER = makeMockUser({
  email: 'dana@example.com',
  name: 'Dana Reyes',
  sessionId: 'session-docs-profiles',
  userId: 'user-docs-profiles',
});

const PROJECTS = [{ id: 'p-web', name: 'Payments API' }];
const NOW = Date.now();
const HOUR = 3_600_000;

type Profile = ReturnType<typeof makeAgentProfile>;

function profile(id: string, name: string, overrides: Record<string, unknown> = {}): Profile {
  return { ...makeAgentProfile(id, name, 'p-web', USER.user.id), ...overrides } as Profile;
}

const NORMAL: Profile[] = [
  profile('astra', 'Code Reviewer', {
    agentType: 'openai-codex',
    model: 'gpt-6-astra',
    effort: 'high',
    taskMode: 'conversation',
  }),
  profile('backend', 'Backend Builder', {
    description: 'Builds backend changes and opens a pull request.',
    agentType: 'openai-codex',
    model: 'gpt-6.1-sol',
    effort: 'medium',
    vmSizeOverride: 'medium',
    taskMode: 'task',
  }),
  profile('careful', 'Careful Builder', {
    model: 'claude-opus-5-5',
    effort: 'high',
    permissionMode: 'bypassPermissions',
    resourceRequirementsJson: JSON.stringify({ minVcpu: 4, minMemoryGb: 7.5, minDiskGb: 60 }),
  }),
  profile('brainstorm', 'Brainstormer', {
    model: 'claude-fable-5-1',
    effort: 'xhigh',
    taskMode: 'conversation',
  }),
  profile('instant', 'Quick Questions', {
    description: 'Chat and explore with a lightweight workspace',
    agentType: 'openai-codex',
    model: 'gpt-6.1-sol',
    effort: 'xhigh',
    runtime: 'cf-container',
    taskMode: 'conversation',
  }),
  profile('opencode', 'OpenCode Explorer', {
    agentType: 'opencode',
    model: 'kimi-k2.5',
    runtime: 'cf-container',
  }),
];

const ROWS = mergeRows(
  accountRows({
    id: 'max',
    name: 'Personal Max',
    kind: 'agent',
    target: 'claude-code',
    credentialKind: 'oauth-token',
    isDefault: true,
  }),
  accountRows({
    id: 'work',
    name: 'Work ChatGPT',
    kind: 'agent',
    target: 'openai-codex',
    credentialKind: 'oauth-token',
    isDefault: true,
  }),
  accountRows({
    id: 'team',
    name: 'Team Codex seat',
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
    profileName: 'Code Reviewer',
    projectId: 'p-web',
    projectName: 'Payments API',
    consumerKind: 'agent',
    consumerTarget: 'openai-codex',
    isActive: true,
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
  },
];

function limitWindow(
  windowType: string,
  utilizationPercent: number,
  overrides: Partial<CredentialLimitWindowSummary> = {}
): CredentialLimitWindowSummary {
  return {
    windowType,
    provider: windowType.startsWith('claude') ? 'anthropic' : 'openai',
    source: 'mock',
    status: 'allowed',
    level: 'ok',
    utilizationPercent,
    limitAmount: null,
    remainingAmount: null,
    windowMinutes: windowType.endsWith('primary')
      ? 300
      : windowType.endsWith('secondary')
        ? 10080
        : null,
    resetsAt: NOW + 3 * HOUR,
    observedAt: NOW - 2 * 60_000,
    updatedAt: NOW - 2 * 60_000,
    ...overrides,
  };
}

function usage(
  credentialId: string,
  agentType: string,
  windows: CredentialLimitWindowSummary[]
): CredentialLimitCredentialSummary {
  return {
    credentialReference: `cc_credentials:${credentialId}`,
    credentialId,
    credentialName: null,
    credentialSource: 'user',
    provider: windows[0]!.provider,
    providerMode: 'oauth',
    agentType,
    level: 'ok',
    observedAt: Math.max(...windows.map((w) => w.observedAt)),
    windows,
  };
}

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

function handler(path: string, respond: AuditResponder): Promise<void> | undefined {
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
  return respondToProfilePageRoute(path, respond, {
    user: USER,
    projects: PROJECTS,
    profiles: NORMAL,
  });
}

function isMobile(page: Page): boolean {
  return (page.viewportSize()?.width ?? 0) < 500;
}

test('docs: the Profiles page with resources and usage', async ({ page }) => {
  await page.addInitScript((userId) => {
    window.localStorage.setItem(`sam-onboarding-wizard-dismissed-${userId}`, 'true');
  }, USER.user.id);
  await setupAuditRoutes(page, handler);
  await page.goto('/projects/p-web/profiles');
  await expect(page.getByTestId('profile-usage-strip')).toHaveCount(5);
  const row = (name: string) =>
    page.getByTestId('profile-row').filter({ has: page.getByRole('button', { name }) });
  await expect(row('Careful Builder')).toContainText('4 vCPU · 7.5 GB');
  await expect(row('Backend Builder')).toContainText('Medium VM');
  await expect(row('Quick Questions')).toContainText('Instant container');
  await expect(row('OpenCode Explorer')).toContainText('No account connected');
  await assertNoOverflow(page);
  await page.mouse.move(2, 2);
  if (isMobile(page)) {
    await page.setViewportSize({ width: 375, height: 900 });
    await docsShot(page, 'profiles-page-mobile');
    return;
  }
  // Keep to the page itself: from the heading down to the last row, without the sidebar.
  const heading = (await page.getByRole('heading', { name: 'Agent Profiles' }).boundingBox())!;
  const last = (await row('OpenCode Explorer').boundingBox())!;
  const x = last.x - 24;
  await docsShot(page, 'profiles-page', {
    clip: {
      x,
      y: heading.y - 24,
      width: last.width + 48,
      height: last.y + last.height + 24 - (heading.y - 24),
    },
  });
});
