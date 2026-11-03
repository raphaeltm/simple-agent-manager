/**
 * Documentation screenshots for agent accounts (Agents guide, "Connecting Agent Accounts"
 * and "Common account tasks"), on a desktop and, where the layout differs, a phone.
 *
 * Drives the REAL accounts surfaces with mocked API data built from the same row fixtures
 * the unit tests use, so lanes, coverage and resolution come from the real account model.
 * The stress and failure cases live in `accounts-settings-audit.spec.ts` and
 * `profile-account-pins-audit.spec.ts`; this fixture uses ordinary, fictional data.
 *
 * Write the committed images with:
 *   DOCS_SHOTS=1 npx playwright test docs-screenshots-accounts \
 *     --project="Desktop (1280x800)" --project="iPhone SE (375x667)"
 */
import { expect, type Page, test } from '@playwright/test';
import type { CCProfileAttachmentItem } from '@simple-agent-manager/shared';

import { accountRows, mergeRows } from '../unit/components/accounts/fixtures';
import {
  type AuditResponder,
  makeMockProject,
  makeMockUser,
  respondToAppShellRoute,
  seedTheme,
  setupAuditRoutes,
} from './audit-helpers';
import { docsShot, opaqueBackdrop } from './docs-shot';

const USER = makeMockUser({
  email: 'dana@example.com',
  name: 'Dana Reyes',
  sessionId: 'session-docs-accounts',
  userId: 'user-dana',
});

const PROJECTS = [
  { id: 'p-web', name: 'Marketing site' },
  { id: 'p-api', name: 'Billing API' },
  { id: 'p-client', name: 'Acme client portal' },
  { id: 'p-labs', name: 'Labs' },
];

const AGENTS = [
  { id: 'claude-code', name: 'Claude Code', description: 'Anthropic', configured: true },
  { id: 'openai-codex', name: 'Codex', description: 'OpenAI', configured: true },
  { id: 'opencode', name: 'OpenCode', description: 'OpenCode', configured: true },
  { id: 'google-gemini', name: 'Gemini CLI', description: 'Google', configured: false },
];

const ROWS = mergeRows(
  accountRows({
    id: 'work',
    name: 'Work Max plan',
    kind: 'agent',
    target: 'claude-code',
    credentialKind: 'oauth-token',
    isDefault: true,
    createdAt: '2026-08-01T00:00:00.000Z',
  }),
  accountRows({
    id: 'acme',
    name: 'Acme client key',
    kind: 'agent',
    target: 'claude-code',
    pins: ['p-client'],
    createdAt: '2026-09-02T00:00:00.000Z',
  }),
  accountRows({
    id: 'personal',
    name: 'Personal Pro plan',
    kind: 'agent',
    target: 'claude-code',
    credentialKind: 'oauth-token',
    createdAt: '2026-10-03T00:00:00.000Z',
  }),
  accountRows({
    id: 'chatgpt',
    name: 'ChatGPT Plus',
    kind: 'agent',
    target: 'openai-codex',
    credentialKind: 'auth-json',
    isDefault: true,
  }),
  accountRows({
    id: 'go',
    name: 'OpenCode Go',
    kind: 'agent',
    target: 'opencode',
    isDefault: true,
  })
);

const DEEP_WORK_PIN: CCProfileAttachmentItem = {
  id: 'pin-deep',
  configurationId: 'cfg-personal',
  agentProfileId: 'prof-deep',
  profileName: 'Opus deep work',
  projectId: 'p-web',
  projectName: 'Marketing site',
  consumerKind: 'agent',
  consumerTarget: 'claude-code',
  isActive: true,
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
};

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

const MEMBERS = [
  { id: USER.user.id, name: 'Dana Reyes', role: 'owner' },
  { id: 'user-ben', name: 'Ben Okafor', role: 'admin' },
];

function members(projectId: string) {
  return MEMBERS.map((each) => ({
    projectId,
    userId: each.id,
    role: each.role,
    status: 'active',
    invitedBy: null,
    createdAt: '2026-07-04T00:00:00.000Z',
    updatedAt: '2026-07-04T00:00:00.000Z',
    user: {
      id: each.id,
      name: each.name,
      email: `${each.id}@example.com`,
      image: null,
      avatarUrl: null,
    },
  }));
}

const SETUP_SESSION = {
  id: 'docs-guided-claude',
  status: 'waiting_for_user',
  agentType: 'claude-code',
  expiresAt: '2099-01-01T00:00:00.000Z',
  verificationUrl: 'https://claude.ai/oauth/authorize?client_id=docs-example',
  userCode: null,
  errorCode: null,
  errorMessage: null,
};

function handler(profilePins: CCProfileAttachmentItem[]) {
  return (path: string, respond: AuditResponder): Promise<void> | undefined => {
    if (path === '/api/cc/credentials') return respond(200, { credentials: ROWS.credentials });
    if (path === '/api/cc/configurations') {
      return respond(200, { configurations: ROWS.configurations });
    }
    if (path === '/api/cc/attachments') return respond(200, { attachments: ROWS.attachments });
    if (path === '/api/cc/profile-attachments') return respond(200, { attachments: profilePins });
    if (path === '/api/cc/profile-attachments/profiles') {
      return respond(200, { profiles: [], truncated: false, limit: 200 });
    }
    if (path === '/api/credentials/resolution-status') return respond(200, { consumers: [] });
    if (path === '/api/credentials/limits') return respond(200, { credentials: [] });
    if (path === '/api/agents') return respond(200, { agents: AGENTS });
    if (path.startsWith('/api/agent-settings/')) return respond(200, null);
    if (path.startsWith('/api/model-catalog/')) {
      return respond(200, { agentType: 'x', source: 'static', updatedAt: null, groups: [] });
    }
    if (path.startsWith('/api/capacity-pools/defaults')) return respond(200, null);
    if (path.match(/^\/api\/projects\/[^/]+\/capacity-pools\/defaults/)) return respond(200, null);
    if (path === '/api/agent-credential-setup-sessions/config') {
      return respond(200, {
        enabled: true,
        agentType: 'openai-codex',
        agentTypes: ['openai-codex', 'claude-code'],
        scopes: ['user', 'project'],
      });
    }
    if (path === '/api/agent-credential-setup-sessions') return respond(201, SETUP_SESSION);
    if (path === `/api/agent-credential-setup-sessions/${SETUP_SESSION.id}`) {
      return respond(200, SETUP_SESSION);
    }
    const memberList = path.match(/^\/api\/projects\/([^/]+)\/members$/);
    if (memberList) {
      return respond(200, {
        members: members(memberList[1]!),
        inviteLinks: [],
        accessRequests: [],
      });
    }
    if (/^\/api\/projects\/[^/]+\/skills$/.test(path)) return respond(200, { items: [] });
    if (/^\/api\/projects\/[^/]+\/agent-profiles$/.test(path)) {
      return respond(200, {
        items: [
          profile('prof-deep', 'Opus deep work', 'p-web'),
          profile('prof-review', 'Careful reviewer', 'p-web'),
        ],
      });
    }
    if (/\/agent-profiles\/[^/]+\/runtime\/env-vars$/.test(path)) {
      return respond(200, { envVars: [] });
    }
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

async function openPage(page: Page, path: string, profilePins: CCProfileAttachmentItem[] = []) {
  await seedTheme(page, 'dark');
  await page.addInitScript((userId) => {
    window.localStorage.setItem(`sam-onboarding-wizard-dismissed-${userId}`, 'true');
  }, USER.user.id);
  await setupAuditRoutes(page, handler(profilePins));
  await page.goto(path);
}

function isMobile(page: Page): boolean {
  return (page.viewportSize()?.width ?? 0) < 500;
}

test('docs: agent accounts with a default, a pinned and an unattached account', async ({
  page,
}) => {
  if (isMobile(page)) await page.setViewportSize({ width: 375, height: 2200 });
  else await page.setViewportSize({ width: 1280, height: 1200 });
  await openPage(page, '/settings/agents');
  const claude = page.getByTestId('provider-row-claude-code');
  await expect(claude.getByTestId('account-card-cfg-work')).toContainText('Used by 3 of 4');
  await expect(claude.getByTestId('account-card-cfg-acme')).toContainText('Acme client portal');
  await expect(claude.getByTestId('account-card-cfg-personal')).toContainText(
    'Connected, but nothing uses it.'
  );
  await page.mouse.move(2, 2);
  const section = page.locator('section[aria-labelledby="accounts-section-title"]');
  await docsShot(page, isMobile(page) ? 'accounts-agents-mobile' : 'accounts-agents', section);
});

test('docs: make another account your default', async ({ page }) => {
  test.skip(isMobile(page), 'The dialog reads the same on a phone');
  await openPage(page, '/settings/agents');
  const personal = page.getByTestId('account-card-cfg-personal');
  await personal.getByRole('button', { name: 'Make default' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Make Personal Pro plan your default?');
  await expect(dialog).toContainText('3 projects using Work Max plan will switch');
  await opaqueBackdrop(page);
  await docsShot(page, 'accounts-make-default', dialog.locator('.glass-panel-container'));
});

test('docs: pick an existing account for one project', async ({ page }) => {
  await openPage(page, '/projects/p-labs/settings/accounts');
  const claude = page.getByTestId('project-account-row-claude-code');
  await expect(claude).toContainText('Your default');
  const expand = claude.getByRole('button', { expanded: false }).first();
  if (await expand.isVisible()) await expand.click();
  await claude.getByRole('button', { name: /Use another account here/ }).click();
  const picker = claude.getByRole('group', { name: 'Your Claude Code accounts' });
  await expect(picker.getByRole('button', { name: /Personal Pro plan/ })).toBeVisible();
  await expect(picker).toContainText('Pinned in Acme client portal');
  await expect(picker.getByRole('button', { name: 'Connect a new account' })).toBeVisible();
  await page.mouse.move(2, 2);
  await claude.scrollIntoViewIfNeeded();
  await docsShot(
    page,
    isMobile(page) ? 'accounts-project-picker-mobile' : 'accounts-project-picker',
    claude
  );
});

test('docs: choose the account a profile runs on', async ({ page }) => {
  test.skip(isMobile(page), 'The section reads the same on a phone');
  await openPage(page, '/projects/p-web/profiles?edit=prof-deep', [DEEP_WORK_PIN]);
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: /^Account/ }).click();
  const section = dialog.getByTestId('profile-account-section');
  await expect(section).toContainText('Only you see this');
  await expect(section.getByRole('radio', { name: /Personal Pro plan/ })).toBeChecked();
  await expect(section.getByTestId('profile-account-outcome')).toHaveText(
    'Runs Claude Code on Personal Pro plan.'
  );
  await section.scrollIntoViewIfNeeded();
  await page.mouse.move(2, 2);
  await docsShot(page, 'accounts-profile-account', section);
});

test('docs: guided subscription sign-in modal (Claude Code)', async ({ page }) => {
  test.skip(isMobile(page), 'The modal reads the same on a phone');
  await openPage(page, '/settings/agents');
  await page.getByRole('button', { name: 'Connect account' }).click();
  await page
    .getByRole('dialog', { name: 'Connect an agent account' })
    .getByRole('button', { name: /Claude Code/ })
    .click();
  await page.getByRole('button', { name: 'Connect with Claude Code' }).click();
  const modal = page.getByRole('dialog', { name: 'Connect with Claude Code' });
  await expect(modal.getByRole('link', { name: 'Open Claude sign-in' })).toBeVisible();
  await expect(modal).toContainText('saved as your personal default');
  await expect(modal.getByRole('button', { name: 'Continue sign-in' })).toBeDisabled();
  await opaqueBackdrop(page);
  await docsShot(page, 'agent-guided-login', modal.locator('.glass-panel-container'));
});
