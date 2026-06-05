/**
 * Playwright video recordings of the Choose-Your-Path onboarding wizard.
 *
 * Records 14 videos: 7 user-journey scenarios x 2 viewports (mobile + desktop).
 * Videos are saved to .codex/tmp/playwright-recordings/ for upload to SAM library.
 *
 * Run with:
 *   npx playwright test onboarding-wizard-recordings --project="iPhone SE (375x667)" --project="Desktop (1280x800)"
 */
import { expect, type Page, type Route,test } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------------------------------------------------------------------
// Mock Data
// ---------------------------------------------------------------------------

const MOCK_USER = {
  user: {
    id: 'user-demo-1',
    email: 'demo@example.com',
    name: 'Demo User',
    image: null,
    role: 'superadmin',
    status: 'active',
    emailVerified: true,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
  session: {
    id: 'session-demo-1',
    userId: 'user-demo-1',
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    token: 'mock-token',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
};

const MOCK_REPOS = [
  {
    id: 12345,
    fullName: 'acme-corp/web-app',
    name: 'web-app',
    private: false,
    defaultBranch: 'main',
    installationId: 'inst-1',
    url: 'https://github.com/acme-corp/web-app',
  },
  {
    id: 12346,
    fullName: 'acme-corp/api-server',
    name: 'api-server',
    private: true,
    defaultBranch: 'main',
    installationId: 'inst-1',
    url: 'https://github.com/acme-corp/api-server',
  },
  {
    id: 12347,
    fullName: 'acme-corp/mobile-app',
    name: 'mobile-app',
    private: false,
    defaultBranch: 'develop',
    installationId: 'inst-1',
    url: 'https://github.com/acme-corp/mobile-app',
  },
];

const MOCK_INSTALLATIONS = [
  {
    id: 'inst-1',
    appId: 'app-1',
    accountLogin: 'acme-corp',
    accountType: 'Organization',
    createdAt: '2026-01-01T00:00:00Z',
  },
];

const MOCK_PROJECT = {
  id: 'proj-new-1',
  name: 'web-app',
  description: null,
  repository: 'https://github.com/acme-corp/web-app.git',
  defaultBranch: 'main',
  repoProvider: 'github',
  installationId: 'inst-1',
  userId: 'user-demo-1',
  createdAt: '2026-01-15T00:00:00Z',
  updatedAt: '2026-01-15T00:00:00Z',
  summary: {
    activeSessionCount: 0,
    lastActivityAt: null,
    taskCountsByStatus: {},
    linkedWorkspaces: 0,
  },
};

// ---------------------------------------------------------------------------
// Scenario Definitions
// ---------------------------------------------------------------------------

interface Scenario {
  name: string;
  /** Short slug for filename */
  slug: string;
  /** Description of this user persona */
  persona: string;
  /** Question answers: [questionId, optionId][] */
  answers: [string, string][];
  /** Whether step execution includes API key entry */
  hasApiKey: boolean;
  /** Whether step execution includes Hetzner token entry */
  hasHetzner: boolean;
}

const SCENARIOS: Scenario[] = [
  {
    name: '1. Claude Pro + Hetzner + Own Repo',
    slug: '01-claude-pro-hetzner-repo',
    persona: 'Advanced user: has Claude Pro/Max, owns Hetzner account, has a GitHub repo ready',
    answers: [
      ['ai-subscription', 'claude-pro'],
      ['cloud-account', 'hetzner'],
      ['github-ready', 'yes'],
    ],
    hasApiKey: false,
    hasHetzner: true,
  },
  {
    name: '2. Claude Pro + SAM Infra + Pick Repo Later',
    slug: '02-claude-pro-sam-infra-pick-later',
    persona: 'Subscription user: has Claude Pro, lets SAM handle infra, picks a repo after connecting',
    answers: [
      ['ai-subscription', 'claude-pro'],
      ['cloud-account', 'no-cloud'],
      ['github-ready', 'no-repo'],
    ],
    hasApiKey: false,
    hasHetzner: false,
  },
  {
    name: '3. Anthropic API Key + Hetzner + Own Repo',
    slug: '03-anthropic-key-hetzner-repo',
    persona: 'Developer: has Anthropic API key, owns Hetzner account, has a repo',
    answers: [
      ['ai-subscription', 'api-key'],
      ['which-api-key', 'anthropic'],
      ['cloud-account', 'hetzner'],
      ['github-ready', 'yes'],
    ],
    hasApiKey: true,
    hasHetzner: true,
  },
  {
    name: '4. OpenAI API Key + SAM Infra + Own Repo',
    slug: '04-openai-key-sam-infra-repo',
    persona: 'OpenAI developer: has OpenAI API key, SAM-managed infra, has a repo',
    answers: [
      ['ai-subscription', 'api-key'],
      ['which-api-key', 'openai'],
      ['cloud-account', 'no-cloud'],
      ['github-ready', 'yes'],
    ],
    hasApiKey: true,
    hasHetzner: false,
  },
  {
    name: '5. Complete Beginner (SAM Everything + Pick Repo Later)',
    slug: '05-beginner-sam-everything-pick-later',
    persona: 'Complete beginner: no AI subscription, no cloud, picks a repo after connecting',
    answers: [
      ['ai-subscription', 'nothing'],
      ['cloud-account', 'no-cloud'],
      ['github-ready', 'no-repo'],
    ],
    hasApiKey: false,
    hasHetzner: false,
  },
  {
    name: '6. No AI + Hetzner + Own Repo',
    slug: '06-no-ai-hetzner-repo',
    persona: 'Has cloud but no AI: SAM-managed AI billing, owns Hetzner, has a repo',
    answers: [
      ['ai-subscription', 'nothing'],
      ['cloud-account', 'hetzner'],
      ['github-ready', 'yes'],
    ],
    hasApiKey: false,
    hasHetzner: true,
  },
  {
    name: '7. OpenAI API Key + Hetzner + Pick Repo Later',
    slug: '07-openai-key-hetzner-pick-later',
    persona: 'OpenAI dev with own cloud: OpenAI API key, Hetzner, picks a repo after connecting',
    answers: [
      ['ai-subscription', 'api-key'],
      ['which-api-key', 'openai'],
      ['cloud-account', 'hetzner'],
      ['github-ready', 'no-repo'],
    ],
    hasApiKey: true,
    hasHetzner: true,
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const RECORDINGS_DIR = path.resolve(__dirname, '../../../../.codex/tmp/playwright-recordings');

/**
 * Set up API mocks so the wizard renders as a fresh user (no existing setup).
 * GitHub installation polling is mocked to "succeed" after a short delay.
 */
async function setupApiMocks(page: Page, options: {
  /** After GitHub install step, should polling find an installation? */
  githubInstalled?: boolean;
}) {
  const { githubInstalled = true } = options;
  let githubPollCount = 0;

  await page.route('**/api/**', async (route: Route) => {
    const url = new URL(route.request().url());
    const p = url.pathname;
    const method = route.request().method();
    const respond = (status: number, body: unknown) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

    // Auth
    if (p.includes('/api/auth/')) return respond(200, MOCK_USER);

    // Dashboard data
    if (p === '/api/dashboard/active-tasks') return respond(200, { tasks: [] });
    if (p.startsWith('/api/notifications')) return respond(200, { notifications: [], unreadCount: 0 });
    if (p === '/api/agents') return respond(200, []);

    // Agent credentials — must match before /api/credentials (more specific first)
    if (p === '/api/credentials/agent/validate' && method === 'POST') return respond(200, { valid: true, message: 'API key is valid' });
    if (p === '/api/credentials/agent' && method === 'GET') return respond(200, { credentials: [] });
    if (p === '/api/credentials/agent' && (method === 'POST' || method === 'PUT')) return respond(200, { id: 'agent-cred-new', provider: 'anthropic', providerMode: 'user-api-key' });

    // Cloud credentials — fresh user
    if (p === '/api/credentials/validate' && method === 'POST') return respond(200, { valid: true });
    if (p === '/api/credentials' && method === 'GET') return respond(200, []);
    if (p === '/api/credentials' && method === 'POST') return respond(200, { id: 'cred-new', provider: 'hetzner' });

    // Trial status
    if (p === '/api/trial-status') return respond(200, { available: false });

    // GitHub installations — fresh, then installed after polling
    if (p === '/api/github/installations') {
      githubPollCount++;
      if (githubInstalled && githubPollCount > 2) {
        return respond(200, MOCK_INSTALLATIONS);
      }
      return respond(200, []);
    }

    // GitHub install URL
    if (p === '/api/github/install-url') {
      return respond(200, { url: 'https://github.com/apps/sam-agent/installations/new' });
    }

    // Repositories
    if (p === '/api/github/repositories') {
      return respond(200, { repositories: MOCK_REPOS });
    }

    // Create project
    if (p === '/api/projects' && method === 'POST') {
      return respond(201, MOCK_PROJECT);
    }

    // Project-scoped routes
    if (p.match(/^\/api\/projects\/[^/]+/)) {
      const sub = p.replace(/^\/api\/projects\/[^/]+/, '');
      if (sub === '/sessions' || sub.startsWith('/sessions')) return respond(200, { sessions: [], total: 0 });
      if (sub === '/runtime-config') return respond(200, { envVars: [], files: [] });
      if (sub === '/ideas') return respond(200, { ideas: [], total: 0 });
      if (sub === '/knowledge') return respond(200, { entities: [] });
      if (sub === '/activity') return respond(200, { events: [] });
      if (sub === '/triggers') return respond(200, { triggers: [] });
      if (sub === '/policies') return respond(200, []);
      if (sub === '/agent-profiles') return respond(200, { items: [] });
      if (sub === '/tasks') return respond(200, { tasks: [], total: 0 });
      if (sub === '/credentials') return respond(200, []);
      if (sub === '/cached-commands') return respond(200, { commands: [] });
      if (sub === '/devcontainer-configs') return respond(200, { configs: [] });
      if (sub === '/library') return respond(200, { files: [], total: 0 });
      if (sub === '/library/directories') return respond(200, { directories: [] });
      if (sub === '' && method === 'GET') return respond(200, MOCK_PROJECT);
      return respond(200, {});
    }

    // Projects list
    if (p === '/api/projects' && method === 'GET') return respond(200, { projects: [] });

    // Workspaces
    if (p.startsWith('/api/workspaces')) return respond(200, []);

    // Catch-all
    return respond(200, {});
  });
}

/**
 * Click an option button by its label text within the onboarding wizard.
 */
async function clickOption(page: Page, label: string) {
  const wizard = page.locator('[data-testid="onboarding-wizard"]');
  await wizard.getByRole('button', { name: label }).click();
}

/**
 * Assert the wizard does not produce horizontal overflow at the current
 * viewport — protects against long copy/labels breaking the mobile layout.
 */
async function assertNoOverflow(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth
  );
  expect(overflow).toBe(false);
}

/**
 * Run through the full wizard flow for a given scenario while recording.
 */
async function runScenario(page: Page, scenario: Scenario) {
  await setupApiMocks(page, { githubInstalled: true });

  // Navigate to dashboard
  await page.goto('/dashboard');
  await page.waitForSelector('[data-testid="onboarding-wizard"]', { timeout: 15000 });
  await page.waitForTimeout(800);

  const wizard = page.locator('[data-testid="onboarding-wizard"]');
  await assertNoOverflow(page);

  // Phase 1: Answer questions
  for (const [, optionId] of scenario.answers) {
    // Find the button matching the option ID — use the option label mapping
    const optionLabel = getOptionLabel(optionId);
    await clickOption(page, optionLabel);
    await page.waitForTimeout(600);
  }

  // Phase 2: Path Preview — pause to show the plan
  await expect(wizard.getByRole('heading', { name: 'Your personalized setup' })).toBeVisible({ timeout: 5000 });
  await assertNoOverflow(page);
  await page.waitForTimeout(1500);

  // Click "Start setup"
  await wizard.getByRole('button', { name: /Start setup/ }).click();
  await page.waitForTimeout(800);

  // Phase 3: Step Execution — interact with each step
  // First step depends on AI choice
  const firstStepTitle = await wizard.locator('h3').first().textContent();

  // Handle AI step
  if (scenario.hasApiKey) {
    // API key entry
    await page.waitForTimeout(400);
    const apiKeyInput = wizard.locator('#onboarding-api-key');
    await apiKeyInput.fill('sk-ant-demo-key-1234567890abcdef');
    await page.waitForTimeout(400);
    // Click "Show details" to reveal info
    await wizard.getByText('Show details').click();
    await page.waitForTimeout(800);
    // Click action button
    await wizard.getByRole('button', { name: /Save API Key/ }).click();
    await page.waitForTimeout(1000);
  } else if (firstStepTitle?.includes('Connect your Claude')) {
    // OAuth — just click Continue
    await wizard.getByRole('button', { name: 'Continue' }).click();
    await page.waitForTimeout(800);
  } else if (firstStepTitle?.includes('SAM-managed')) {
    // SAM billing — click Continue
    await wizard.getByRole('button', { name: 'Continue' }).click();
    await page.waitForTimeout(800);
  }

  // Handle Cloud step (if Hetzner)
  if (scenario.hasHetzner) {
    await page.waitForTimeout(400);
    const hetznerInput = wizard.locator('#onboarding-hetzner-token');
    if (await hetznerInput.isVisible()) {
      await hetznerInput.fill('hetzner-demo-token-abcdef123456');
      await page.waitForTimeout(400);
      // Show details
      await wizard.getByText('Show details').click();
      await page.waitForTimeout(800);
      await wizard.getByRole('button', { name: /Enter Hetzner Token/ }).click();
      await page.waitForTimeout(1000);
    }
  }

  // Handle Cloud SAM step (auto-continue if not Hetzner)
  if (!scenario.hasHetzner) {
    // cloud-sam step might already be auto-handled (isOptional=true for non-byoc)
    // Check if Continue button visible for cloud-sam
    const continueBtn = wizard.getByRole('button', { name: 'Continue' });
    if (await continueBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
      await continueBtn.click();
      await page.waitForTimeout(800);
    }
  }

  // Handle GitHub step — click "Install GitHub App" which opens new tab + polls
  const githubBtn = wizard.getByRole('button', { name: /Install GitHub App/ });
  if (await githubBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
    // Block the new tab from actually opening
    await page.context().on('page', async (newPage) => {
      await newPage.close();
    });
    await githubBtn.click();
    // Wait for polling to detect installation (mocked to succeed after 2 polls)
    await page.waitForTimeout(8000);
  }

  // Handle Project step — repo selector: wait for repos to load, select one, create project
  await page.waitForTimeout(1500);
  const repoSelect = wizard.locator('#onboarding-repo-select');
  if (await repoSelect.isVisible({ timeout: 3000 }).catch(() => false)) {
    await repoSelect.selectOption('acme-corp/web-app');
    await page.waitForTimeout(600);
    await wizard.getByRole('button', { name: /Create Project/ }).click();
    await page.waitForTimeout(1500);
  }

  // Phase 4: Completion screen
  const completionHeader = wizard.getByText("You're all set!");
  if (await completionHeader.isVisible({ timeout: 5000 }).catch(() => false)) {
    await page.waitForTimeout(2000);
  }

  // Final pause
  await page.waitForTimeout(1000);
}

/**
 * Map option ID to its visible label text for clicking.
 */
function getOptionLabel(optionId: string): string {
  const labels: Record<string, string> = {
    'claude-pro': 'Claude Pro or Max subscription',
    'api-key': 'I have an API key',
    'nothing': 'Use SAM-managed AI',
    'anthropic': 'Anthropic (Claude)',
    'openai': 'OpenAI',
    'hetzner': 'I have Hetzner',
    'no-cloud': 'Use SAM-managed infrastructure',
    'yes': 'Yes, I have a repo',
    'no-repo': "Not yet, I'll pick one after connecting",
  };
  return labels[optionId] ?? optionId;
}

// ---------------------------------------------------------------------------
// Test Definitions — one per scenario
// ---------------------------------------------------------------------------

// Ensure recordings directory exists
fs.mkdirSync(RECORDINGS_DIR, { recursive: true });

// Enable video recording at top level
test.use({
  video: {
    mode: 'on',
    size: { width: 1280, height: 800 },
  },
});

for (const scenario of SCENARIOS) {
  test(`${scenario.name} — ${scenario.persona}`, async ({ page }, testInfo) => {
    await runScenario(page, scenario);

    // After test completes, save video with descriptive name
    await page.close();
    const video = page.video();
    if (video) {
      const viewport = testInfo.project.name.includes('Desktop') ? 'desktop' : 'mobile';
      const destPath = path.join(RECORDINGS_DIR, `${scenario.slug}-${viewport}.webm`);
      await video.saveAs(destPath);
    }
  });
}
