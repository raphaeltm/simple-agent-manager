/**
 * Visual audit for the project Agent Profiles list: a table on desktop, three-line
 * rows on phones, with each profile's resource request and the usage of the
 * account it runs on.
 *
 * Account rows come from the unit-test fixtures, so which account a profile
 * resolves to is computed by the real account model and shared resolver.
 */
import { expect, type Page, test } from '@playwright/test';
import type { CCProfileAttachmentItem } from '@simple-agent-manager/shared';

import { accountRows, mergeRows } from '../unit/components/accounts/fixtures';
import {
  assertNoOverflow,
  type AuditResponder,
  makeMockUser,
  screenshot,
  seedTheme,
  setupAuditRoutes,
} from './audit-helpers';
import { credentialUsage as usage, limitWindow } from './credential-limit-fixtures';
import { makeAgentProfile, respondToProfilePageRoute } from './profile-account-fixtures';

const USER = makeMockUser({
  email: 'raphael@example.com',
  name: 'Raphaël',
  sessionId: 'session-profiles-list',
  userId: 'user-profiles-list',
});

const PROJECTS = [{ id: 'p-web', name: 'Marketing site' }];
const NOW = Date.now();
const HOUR = 3_600_000;
const LONG = 'Overnight-Migration-Reviewer-With-An-Unbroken-Name-'.repeat(3);

type Profile = ReturnType<typeof makeAgentProfile>;

function profile(id: string, name: string, overrides: Record<string, unknown> = {}): Profile {
  return { ...makeAgentProfile(id, name, 'p-web', USER.user.id), ...overrides } as Profile;
}

const NORMAL: Profile[] = [
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

const LONG_TEXT: Profile[] = [
  profile('long', `${LONG} <script>alert("x")</script> 日本語 🚀`, {
    description: `A long description with a URL https://example.com/${LONG}`,
    model: 'gemini-3.5-pro-preview-2026-10-experimental-extended-context-window',
    agentType: 'claude-code',
    effort: 'max',
    taskMode: 'task',
    permissionMode: 'acceptEdits',
    resourceRequirementsJson: JSON.stringify({
      minVcpu: 8,
      minMemoryGb: 15.5,
      minDiskGb: 160,
      exclusiveNode: true,
    }),
    isBuiltin: true,
  }),
  profile('a', 'A'),
  ...NORMAL.slice(0, 2),
];

const MANY: Profile[] = Array.from({ length: 30 }, (_, index) =>
  profile(`many-${index}`, `Profile ${index + 1}`, {
    agentType: index % 2 === 0 ? 'claude-code' : 'openai-codex',
    model: index % 3 === 0 ? null : 'claude-opus-5-5',
    vmSizeOverride: index % 4 === 0 ? 'large' : null,
    taskMode: index % 2 === 0 ? 'task' : 'conversation',
  })
);

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

interface Scenario {
  profiles: Profile[];
  failProfiles?: boolean;
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
      user: USER,
      projects: PROJECTS,
      profiles: scenario.profiles,
    });
  };
}

async function openProfiles(page: Page, scenario: Scenario) {
  await page.addInitScript((userId) => {
    window.localStorage.setItem(`sam-onboarding-wizard-dismissed-${userId}`, 'true');
  }, USER.user.id);
  await setupAuditRoutes(page, handler(scenario));
  await page.goto('/projects/p-web/profiles');
}

function audits(viewport: 'mobile' | 'desktop') {
  const shot = (page: Page, name: string) => screenshot(page, `profiles-list-${name}-${viewport}`);

  test('shows each profile with its requests and its account usage', async ({ page }) => {
    await openProfiles(page, { profiles: NORMAL });
    await expect(page.getByTestId('profile-usage-strip')).toHaveCount(5);
    const row = (name: string) =>
      page.getByTestId('profile-row').filter({ has: page.getByRole('button', { name }) });
    // Astra is pinned to the team seat, whose 5h window reset after the sample.
    await expect(row('Astra High').getByTestId('profile-usage-strip')).toHaveText(/5h\s*0%\s*↻/);
    await expect(row('Backend Implementation').getByTestId('profile-usage-strip')).toHaveText(
      /5h\s*94%/
    );
    await expect(row('Claudiii')).toContainText('4 vCPU · 7.5 GB');
    await expect(row('Backend Implementation')).toContainText('Medium VM');
    await expect(row('Instant')).toContainText('Instant container');
    await expect(row('OC')).toContainText('No account connected');
    // Column labels belong to the desktop table only; phones stack each row instead.
    const usageHeader = page.getByText('Usage', { exact: true });
    if (viewport === 'desktop') await expect(usageHeader).toBeVisible();
    else await expect(usageHeader).toBeHidden();
    await assertNoOverflow(page);
    await shot(page, 'normal');
  });

  test('reads in the light theme', async ({ page }) => {
    await seedTheme(page, 'light');
    await openProfiles(page, { profiles: NORMAL });
    await expect(page.getByTestId('profile-usage-strip')).toHaveCount(5);
    await expect(page.locator('html')).toHaveAttribute('data-ui-theme', 'sam-light');
    await assertNoOverflow(page);
    await shot(page, 'light');
  });

  test('opens the usage breakdown from the strip', async ({ page }) => {
    await openProfiles(page, { profiles: NORMAL });
    const strip = page
      .getByTestId('profile-row')
      .filter({ has: page.getByRole('button', { name: 'Astra High' }) })
      .getByTestId('profile-usage-strip');
    await strip.click();
    const details = page.getByTestId('credential-limit-details');
    await expect(details).toBeVisible();
    await expect(details).toContainText('reset 2h ago · no sample since');
    await assertNoOverflow(page);
    await shot(page, 'usage-details');
  });

  test('sorts by most room left', async ({ page }) => {
    await openProfiles(page, { profiles: NORMAL });
    await expect(page.getByTestId('profile-usage-strip')).toHaveCount(5);
    await page.getByRole('button', { name: 'Most room' }).click();
    // Codex Team seat: 42% left on the week; Raph Max: 12% left on Opus week.
    await expect(page.getByTestId('profile-row').first()).toContainText('Astra High');
    await shot(page, 'sorted');
  });

  test('long and special-character text wraps without overflow', async ({ page }) => {
    await openProfiles(page, { profiles: LONG_TEXT });
    await expect(page.getByTestId('profile-row')).toHaveCount(LONG_TEXT.length);
    await expect(page.getByText('own node')).toBeVisible();
    await assertNoOverflow(page);
    await shot(page, 'long-text');
  });

  test('delete asks for confirmation from the actions menu', async ({ page }) => {
    await openProfiles(page, { profiles: LONG_TEXT });
    await page.getByRole('button', { name: /^Actions for Overnight/ }).click();
    await page.getByRole('menuitem', { name: 'Delete' }).click();
    await expect(page.getByRole('button', { name: /^Confirm delete Overnight/ })).toBeVisible();
    await assertNoOverflow(page);
    await shot(page, 'delete-confirm');
  });

  test('many profiles', async ({ page }) => {
    await openProfiles(page, { profiles: MANY });
    await expect(page.getByTestId('profile-row')).toHaveCount(30);
    await assertNoOverflow(page);
    await shot(page, 'many');
  });

  test('empty state', async ({ page }) => {
    await openProfiles(page, { profiles: [] });
    await expect(page.getByText(/No profiles yet/)).toBeVisible();
    await assertNoOverflow(page);
    await shot(page, 'empty');
  });

  test('error state', async ({ page }) => {
    await openProfiles(page, { profiles: [], failProfiles: true });
    await expect(page.locator('.text-danger')).toBeVisible();
    await assertNoOverflow(page);
    await shot(page, 'error');
  });
}

test.describe('Profiles list — mobile', () => {
  test.use({ viewport: { width: 375, height: 667 }, isMobile: true });
  audits('mobile');
});

test.describe('Profiles list — desktop', () => {
  test.use({ viewport: { width: 1280, height: 800 }, isMobile: false });
  audits('desktop');
});
