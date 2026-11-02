/**
 * Visual audit for personal profile pins:
 *   - Settings → Agents: profile chips on an account card, and "Use in profiles…"
 *   - Profile editor: the Account section (shared project, paused pin, no accounts)
 *   - Project settings → Accounts: profiles that use their own account
 *
 * Rows come from the same fixtures the unit tests use, so roles and resolution are
 * computed by the real account model and the shared resolver.
 */
import type { CCProfileAttachmentItem, CCProfilePinCandidate } from '@simple-agent-manager/shared';
import { expect, type Page, test } from '@playwright/test';

import { type AccountRows, accountRows, mergeRows } from '../unit/components/accounts/fixtures';
import {
  assertNoOverflow,
  type AuditResponder,
  makeMockProject,
  makeMockUser,
  respondToAppShellRoute,
  screenshot,
  setupAuditRoutes,
} from './audit-helpers';

const USER = makeMockUser({
  email: 'raphael@example.com',
  name: 'Raphaël',
  sessionId: 'session-profile-pins',
  userId: 'user-profile-pins',
});

const LONG = 'Acme-Corporation-Client-Engagement-Anthropic-Max-Plan-Seat-'.repeat(3);

const PROJECTS = [
  { id: 'p-web', name: 'Marketing site' },
  { id: 'p-api', name: 'Billing API' },
  { id: 'p-long', name: `Client portal ${LONG.slice(0, 70)}` },
];

const ROWS = mergeRows(
  accountRows({
    id: 'work',
    name: 'Work Max plan',
    kind: 'agent',
    target: 'claude-code',
    credentialKind: 'oauth-token',
    isDefault: true,
  }),
  accountRows({
    id: 'client',
    name: 'Client API key',
    kind: 'agent',
    target: 'claude-code',
    pins: ['p-api'],
  }),
  accountRows({
    id: 'max',
    name: 'Claude Max (personal)',
    kind: 'agent',
    target: 'claude-code',
    credentialKind: 'oauth-token',
  }),
  accountRows({
    id: 'paused',
    name: 'Old Anthropic key',
    kind: 'agent',
    target: 'claude-code',
    credentialActive: false,
  }),
  accountRows({
    id: 'long',
    name: `${LONG} <script>alert("x")</script> 🚀`,
    kind: 'agent',
    target: 'claude-code',
  })
);

function candidate(
  id: string,
  name: string,
  project: { id: string; name: string } | null
): CCProfilePinCandidate {
  return {
    id,
    name,
    agentType: 'claude-code',
    projectId: project?.id ?? null,
    projectName: project?.name ?? null,
  };
}

const CANDIDATES: CCProfilePinCandidate[] = [
  candidate('prof-global', 'Everyday', null),
  candidate('prof-deep', 'Opus deep work', PROJECTS[0]!),
  candidate('prof-long', `Reviewer ${LONG}`, PROJECTS[2]!),
  ...Array.from({ length: 30 }, (_, index) =>
    candidate(`prof-${index}`, `Profile ${index}`, PROJECTS[index % 2]!)
  ),
];

function pinOn(profileId: string, configurationId: string): CCProfileAttachmentItem {
  const profile = CANDIDATES.find((each) => each.id === profileId)!;
  return {
    id: `pin-${profileId}`,
    configurationId,
    agentProfileId: profileId,
    profileName: profile.name,
    projectId: profile.projectId,
    projectName: profile.projectName,
    consumerKind: 'agent',
    consumerTarget: 'claude-code',
    isActive: true,
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
  };
}

function profile(id: string, name: string, projectId: string | null) {
  return {
    id,
    projectId,
    userId: USER.user.id,
    name,
    description: null,
    agentType: 'claude-code',
    model: null,
    effort: 'auto',
    permissionMode: null,
    systemPromptAppend: null,
    maxTurns: null,
    timeoutMinutes: null,
    vmSizeOverride: null,
    provider: null,
    vmLocation: null,
    workspaceProfile: null,
    devcontainerConfigName: null,
    taskMode: null,
    isBuiltin: false,
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
  };
}

function member(userId: string, role: string) {
  return {
    projectId: 'p-web',
    userId,
    role,
    status: 'active',
    invitedBy: null,
    createdAt: '2026-07-04T00:00:00.000Z',
    updatedAt: '2026-07-04T00:00:00.000Z',
    user: {
      id: userId,
      name: userId,
      email: `${userId}@example.com`,
      image: null,
      avatarUrl: null,
    },
  };
}

interface Scenario {
  rows?: AccountRows;
  pins?: CCProfileAttachmentItem[];
  members?: number;
  failCandidates?: boolean;
  skills?: Array<{ id: string; name: string; agentType: string | null }>;
}

function handler(scenario: Scenario) {
  const rows = scenario.rows ?? ROWS;
  return (path: string, respond: AuditResponder): Promise<void> | undefined => {
    if (path === '/api/cc/credentials') return respond(200, { credentials: rows.credentials });
    if (path === '/api/cc/configurations') {
      return respond(200, { configurations: rows.configurations });
    }
    if (path === '/api/cc/attachments') return respond(200, { attachments: rows.attachments });
    if (path === '/api/cc/profile-attachments') {
      return respond(200, { attachments: scenario.pins ?? [] });
    }
    if (path === '/api/cc/profile-attachments/profiles') {
      return scenario.failCandidates
        ? respond(500, { error: 'INTERNAL_ERROR', message: 'unavailable' })
        : respond(200, { profiles: CANDIDATES, truncated: true, limit: CANDIDATES.length });
    }
    if (path === '/api/credentials/resolution-status') return respond(200, { consumers: [] });
    if (path === '/api/credentials/limits') return respond(200, { credentials: [] });
    if (path === '/api/agents') {
      return respond(200, {
        agents: [
          { id: 'claude-code', name: 'Claude Code', description: 'Anthropic', configured: true },
        ],
      });
    }
    if (path.startsWith('/api/agent-settings/')) return respond(200, null);
    if (path.startsWith('/api/capacity-pools/defaults')) return respond(200, null);
    const members = path.match(/^\/api\/projects\/([^/]+)\/members$/);
    if (members) {
      const count = scenario.members ?? 3;
      return respond(200, {
        members: Array.from({ length: count }, (_, index) =>
          member(
            index === 0 ? USER.user.id : `member-${index}`,
            index === 0 ? 'owner' : 'maintainer'
          )
        ),
        inviteLinks: [],
        accessRequests: [],
      });
    }
    if (/^\/api\/projects\/[^/]+\/skills$/.test(path)) {
      return respond(200, { items: scenario.skills ?? [] });
    }
    if (/^\/api\/projects\/[^/]+\/agent-profiles$/.test(path)) {
      return respond(200, {
        items: [
          profile('prof-deep', 'Opus deep work', 'p-web'),
          profile('prof-global', 'Everyday', null),
        ],
      });
    }
    if (/\/agent-profiles\/[^/]+\/runtime\/env-vars$/.test(path))
      return respond(200, { envVars: [] });
    if (/\/agent-profiles\/[^/]+\/runtime\/files$/.test(path)) return respond(200, { files: [] });
    if (/^\/api\/projects\/[^/]+\/agent-profiles\/picker$/.test(path)) {
      return respond(200, { usage: [], hiddenProfileIds: [], usageWindowDays: 30 });
    }
    if (path === '/api/projects') return respond(200, { projects: PROJECTS });
    const project = path.match(/^\/api\/projects\/([^/]+)$/);
    if (project) {
      const found = PROJECTS.find((each) => each.id === project[1]);
      return respond(200, makeMockProject({ ...found, userId: USER.user.id }));
    }
    return respondToAppShellRoute(path, respond, { user: USER, projects: PROJECTS });
  };
}

async function openPage(page: Page, path: string, scenario: Scenario) {
  await page.addInitScript((userId) => {
    window.localStorage.setItem(`sam-onboarding-wizard-dismissed-${userId}`, 'true');
  }, USER.user.id);
  await setupAuditRoutes(page, handler(scenario));
  await page.goto(path);
}

async function openProfileAccount(page: Page, scenario: Scenario) {
  await openPage(page, '/projects/p-web/profiles?edit=prof-deep', scenario);
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: /^Account/ }).click();
  const section = dialog.getByTestId('profile-account-section');
  await expect(section).toBeVisible();
  return { dialog, section };
}

function audits(viewport: 'mobile' | 'desktop') {
  const shot = (page: Page, name: string) => screenshot(page, `profile-pins-${name}-${viewport}`);

  test('account card lists the profiles that run on it', async ({ page }) => {
    await openPage(page, '/settings/agents', {
      pins: [
        pinOn('prof-global', 'cfg-max'),
        pinOn('prof-deep', 'cfg-max'),
        pinOn('prof-long', 'cfg-max'),
      ],
    });
    const card = page.getByTestId('account-card-cfg-max');
    const chips = card.getByTestId('account-profile-pins');
    await expect(chips).toContainText('Everyday');
    await expect(chips).toContainText('Opus deep work');
    await assertNoOverflow(page);
    const box = await card.boundingBox();
    expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
    await card.scrollIntoViewIfNeeded();
    await shot(page, 'card-chips');
  });

  test('use in profiles: grouped, searchable, long names wrap', async ({ page }) => {
    await openPage(page, '/settings/agents', { pins: [pinOn('prof-deep', 'cfg-client')] });
    const card = page.getByTestId('account-card-cfg-long');
    await card.getByRole('button', { name: /^Actions for/ }).click();
    await page.getByRole('menuitem', { name: 'Use in profiles…' }).click();
    const dialog = page.getByTestId('account-profiles-dialog');
    await expect(dialog.getByRole('checkbox', { name: /Everyday/ })).toBeVisible();
    await expect(dialog.getByRole('checkbox', { name: /Opus deep work/ })).toHaveAccessibleName(
      /Uses Client API key — checking replaces it/
    );
    await expect(dialog).toContainText('Showing the first');
    await assertNoOverflow(page);
    await shot(page, 'dialog');

    await dialog.getByRole('searchbox', { name: 'Search profiles' }).fill('Reviewer');
    await expect(dialog.getByRole('checkbox')).toHaveCount(1);
    await assertNoOverflow(page);
    await shot(page, 'dialog-search');
  });

  test('use in profiles: candidates fail to load', async ({ page }) => {
    await openPage(page, '/settings/agents', { failCandidates: true });
    const card = page.getByTestId('account-card-cfg-max');
    await card.getByRole('button', { name: /^Actions for/ }).click();
    await page.getByRole('menuitem', { name: 'Use in profiles…' }).click();
    const dialog = page.getByTestId('account-profiles-dialog');
    await expect(dialog).toContainText('Couldn’t load your profiles.', { timeout: 15_000 });
    await assertNoOverflow(page);
    await shot(page, 'dialog-error');
  });

  test('profile editor: shared project, pinned account, skill switches agent', async ({ page }) => {
    const { section } = await openProfileAccount(page, {
      pins: [pinOn('prof-deep', 'cfg-max')],
      skills: [{ id: 'sk-1', name: 'Port to Go', agentType: 'openai-codex' }],
    });
    await expect(section).toContainText('Only you see this');
    await expect(section.getByRole('radio', { name: /Claude Max \(personal\)/ })).toBeChecked();
    await expect(section.getByRole('radio', { name: /Old Anthropic key/ })).toBeDisabled();
    await expect(section.getByTestId('profile-account-outcome')).toHaveText(
      'Runs Claude Code on Claude Max (personal).'
    );
    await expect(section).toContainText('Port to Go switches the agent');
    // Nothing needs attention, so the breakdown stays closed.
    await expect(section.getByRole('list', { name: 'How SAM picks the account' })).toBeHidden();
    await assertNoOverflow(page);
    await section.scrollIntoViewIfNeeded();
    await shot(page, 'editor-pinned');
  });

  test('profile editor: a paused pin stops the run and opens the breakdown', async ({ page }) => {
    const { section } = await openProfileAccount(page, {
      pins: [pinOn('prof-deep', 'cfg-paused')],
    });
    await expect(section.getByTestId('profile-account-outcome')).toContainText('Stops:');
    const breakdown = section.getByRole('list', { name: 'How SAM picks the account' });
    await expect(breakdown).toBeVisible();
    await expect(breakdown.getByRole('listitem').first()).toContainText('Stops here');
    await assertNoOverflow(page);
    await breakdown.scrollIntoViewIfNeeded();
    await shot(page, 'editor-halted');
  });

  test('profile editor: no accounts yet, single-person project', async ({ page }) => {
    const { section } = await openProfileAccount(page, { rows: mergeRows(), members: 1 });
    await expect(section).toContainText('You have no Claude Code accounts yet.');
    await expect(section).not.toContainText('Only you see this');
    await expect(section.getByTestId('profile-account-outcome')).toContainText(
      'No Claude Code account'
    );
    await assertNoOverflow(page);
    await shot(page, 'editor-empty');
  });

  test('project accounts: profiles that use their own account', async ({ page }) => {
    await openPage(page, '/projects/p-api/settings/accounts', {
      pins: [pinOn('prof-global', 'cfg-max'), pinOn('prof-1', 'cfg-long')],
    });
    const row = page.getByTestId('project-account-row-claude-code');
    await expect(row).toContainText('2 of your profiles use their own account');
    await expect(row.getByTestId('project-account-profile-overrides')).toBeVisible();
    await assertNoOverflow(page);
    await row.scrollIntoViewIfNeeded();
    await shot(page, 'project-overrides');
  });
}

test.describe('Profile account pins — mobile', () => {
  test.use({ viewport: { width: 375, height: 667 }, isMobile: true });
  audits('mobile');
});

test.describe('Profile account pins — desktop', () => {
  test.use({ viewport: { width: 1280, height: 800 }, isMobile: false });
  audits('desktop');
});
