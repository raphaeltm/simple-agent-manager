import { expect, type Page, type Route, test } from '@playwright/test';

// ---------------------------------------------------------------------------
// Mock Data Factories
// ---------------------------------------------------------------------------

const MOCK_USER = {
  user: {
    id: 'user-test-1',
    email: 'test@example.com',
    name: 'Test User',
    image: null,
    role: 'superadmin',
    status: 'active',
    emailVerified: true,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
  session: {
    id: 'session-test-1',
    userId: 'user-test-1',
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    token: 'mock-token',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
};

const MOCK_AGENT_OPENCODE = {
  id: 'opencode',
  name: 'OpenCode',
  description: 'OpenCode agent with multi-provider support',
};

const MOCK_AGENT_CLAUDE = {
  id: 'claude-code',
  name: 'Claude Code',
  description: 'Anthropic Claude Code agent',
};

const MOCK_AGENT_CODEX = {
  id: 'openai-codex',
  name: 'OpenAI Codex',
  description: 'OpenAI Codex agent',
};

type AgentMock = typeof MOCK_AGENT_OPENCODE;

function makeSettings(overrides: {
  agentType?: string;
  model?: string | null;
  permissionMode?: string | null;
  opencodeProvider?: string | null;
  opencodeBaseUrl?: string | null;
  opencodeProviderName?: string | null;
} = {}) {
  return {
    agentType: overrides.agentType ?? 'opencode',
    model: overrides.model ?? null,
    permissionMode: overrides.permissionMode ?? 'default',
    allowedTools: null,
    deniedTools: null,
    additionalEnv: null,
    opencodeProvider: overrides.opencodeProvider ?? null,
    opencodeBaseUrl: overrides.opencodeBaseUrl ?? null,
    opencodeProviderName: overrides.opencodeProviderName ?? null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
}

// ---------------------------------------------------------------------------
// API Mock Setup
// ---------------------------------------------------------------------------

async function setupApiMocks(
  page: Page,
  options: {
    agents?: AgentMock[];
    settingsMap?: Record<string, ReturnType<typeof makeSettings>>;
    agentsError?: boolean;
  } = {}
) {
  const {
    agents = [MOCK_AGENT_OPENCODE, MOCK_AGENT_CLAUDE],
    settingsMap = {},
    agentsError = false,
  } = options;

  await page.route('**/api/**', async (route: Route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();

    const respond = (status: number, body: unknown) =>
      route.fulfill({
        status,
        contentType: 'application/json',
        body: JSON.stringify(body),
      });

    // Auth (BetterAuth get-session and other auth routes)
    if (path.includes('/api/auth/')) {
      return respond(200, MOCK_USER);
    }

    // Agent list
    if (path === '/api/agents') {
      if (agentsError) {
        return respond(500, { error: 'Failed to load agents' });
      }
      return respond(200, { agents });
    }

    // Agent settings by type
    const settingsMatch = path.match(/^\/api\/agent-settings\/([^/]+)$/);
    if (settingsMatch) {
      const agentType = settingsMatch[1];
      if (method === 'PUT') {
        const body = route.request().postDataJSON() as Record<string, unknown>;
        return respond(200, {
          agentType,
          model: body.model ?? null,
          permissionMode: body.permissionMode ?? 'default',
          allowedTools: null,
          deniedTools: null,
          additionalEnv: null,
          opencodeProvider: body.opencodeProvider ?? null,
          opencodeBaseUrl: body.opencodeBaseUrl ?? null,
          opencodeProviderName: body.opencodeProviderName ?? null,
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: new Date().toISOString(),
        });
      }
      if (method === 'DELETE') {
        return respond(200, {});
      }
      if (settingsMap[agentType]) {
        return respond(200, settingsMap[agentType]);
      }
      return respond(404, { error: 'Not found' });
    }

    // Notifications
    if (path.startsWith('/api/notifications')) {
      return respond(200, { notifications: [], unreadCount: 0 });
    }

    // Projects
    if (path === '/api/projects') {
      return respond(200, { projects: [] });
    }

    // Credentials — API returns array, not object
    if (path === '/api/credentials') {
      return respond(200, []);
    }

    // GitHub
    if (path.startsWith('/api/github')) {
      return respond(200, []);
    }

    // Health
    if (path.endsWith('/health')) {
      return respond(200, { status: 'ok' });
    }

    // Catch-all
    return respond(200, {});
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function assertNoOverflow(page: Page) {
  const overflow = await page.evaluate(() => ({
    docOverflow: document.documentElement.scrollWidth > window.innerWidth,
    bodyOverflow: document.body.scrollWidth > window.innerWidth,
    docWidth: document.documentElement.scrollWidth,
    bodyWidth: document.body.scrollWidth,
    viewportWidth: window.innerWidth,
  }));
  expect(
    overflow.docOverflow,
    `Document scrollWidth (${overflow.docWidth}) exceeds viewport (${overflow.viewportWidth})`
  ).toBe(false);
  expect(
    overflow.bodyOverflow,
    `Body scrollWidth (${overflow.bodyWidth}) exceeds viewport (${overflow.viewportWidth})`
  ).toBe(false);
}

async function takeScreenshot(page: Page, name: string) {
  await page.waitForTimeout(600);
  await page.screenshot({
    path: `../../.codex/tmp/playwright-screenshots/${name}.png`,
    fullPage: true,
  });
}

async function navigateToAgentConfig(page: Page) {
  await page.goto('/settings/agent-config');
  await page.waitForTimeout(1000);
}

// ===========================================================================
// AGENT SETTINGS — Mobile (375x667, default from config)
// ===========================================================================

test.describe('AgentSettingsSection — Mobile', () => {
  test('empty state: no agents configured', async ({ page }) => {
    await setupApiMocks(page, { agents: [] });
    await navigateToAgentConfig(page);
    await takeScreenshot(page, 'agent-settings-mobile-empty');
    await assertNoOverflow(page);
  });

  test('default state: OpenCode with no saved settings', async ({ page }) => {
    await setupApiMocks(page, {
      agents: [MOCK_AGENT_OPENCODE],
      settingsMap: {},
    });
    await navigateToAgentConfig(page);
    await page.waitForSelector('[data-testid="agent-settings-opencode"]');
    await takeScreenshot(page, 'agent-settings-mobile-opencode-default');
    await assertNoOverflow(page);

    // Provider select renders with default option
    const providerSelect = page.getByTestId('opencode-provider-select');
    await expect(providerSelect).toBeVisible();
    await expect(providerSelect).toHaveValue('');

    // Model is a text input when no platform provider is selected
    const modelInput = page.getByTestId('model-input-opencode');
    await expect(modelInput).toBeVisible();
    const tagName = await modelInput.evaluate((el) => el.tagName.toLowerCase());
    expect(tagName).toBe('input');
  });

  test('platform provider: model dropdown renders instead of text input', async ({ page }) => {
    await setupApiMocks(page, {
      agents: [MOCK_AGENT_OPENCODE],
      settingsMap: {
        opencode: makeSettings({ opencodeProvider: 'platform', model: '@cf/meta/llama-4-scout-17b-16e-instruct' }),
      },
    });
    await navigateToAgentConfig(page);
    await page.waitForSelector('[data-testid="agent-settings-opencode"]');
    await takeScreenshot(page, 'agent-settings-mobile-platform-provider');
    await assertNoOverflow(page);

    // Model control must be a <select> (dropdown), NOT a text input
    const modelSelect = page.getByTestId('model-input-opencode');
    await expect(modelSelect).toBeVisible();
    const tagName = await modelSelect.evaluate((el) => el.tagName.toLowerCase());
    expect(tagName).toBe('select');

    // Selected value matches saved model
    await expect(modelSelect).toHaveValue('@cf/meta/llama-4-scout-17b-16e-instruct');
  });

  test('platform provider: switching from text input to dropdown clears model', async ({ page }) => {
    await setupApiMocks(page, {
      agents: [MOCK_AGENT_OPENCODE],
      settingsMap: {
        opencode: makeSettings({ opencodeProvider: 'scaleway', model: 'scaleway/qwen3-coder' }),
      },
    });
    await navigateToAgentConfig(page);
    await page.waitForSelector('[data-testid="agent-settings-opencode"]');

    // Start: scaleway provider, text input with value
    const modelBefore = page.getByTestId('model-input-opencode');
    const tagBefore = await modelBefore.evaluate((el) => el.tagName.toLowerCase());
    expect(tagBefore).toBe('input');
    await expect(modelBefore).toHaveValue('scaleway/qwen3-coder');

    // Switch to platform provider
    await page.getByTestId('opencode-provider-select').selectOption('platform');
    await page.waitForTimeout(300);
    await takeScreenshot(page, 'agent-settings-mobile-switch-to-platform');
    await assertNoOverflow(page);

    // After switch: model control must be select with empty value
    const modelAfter = page.getByTestId('model-input-opencode');
    const tagAfter = await modelAfter.evaluate((el) => el.tagName.toLowerCase());
    expect(tagAfter).toBe('select');
    await expect(modelAfter).toHaveValue('');
  });

  test('platform provider: switching away from platform clears model', async ({ page }) => {
    await setupApiMocks(page, {
      agents: [MOCK_AGENT_OPENCODE],
      settingsMap: {
        opencode: makeSettings({ opencodeProvider: 'platform', model: '@cf/qwen/qwen3-30b-a3b-fp8' }),
      },
    });
    await navigateToAgentConfig(page);
    await page.waitForSelector('[data-testid="agent-settings-opencode"]');

    // Start: platform provider, select with a value
    const modelBefore = page.getByTestId('model-input-opencode');
    const tagBefore = await modelBefore.evaluate((el) => el.tagName.toLowerCase());
    expect(tagBefore).toBe('select');
    await expect(modelBefore).toHaveValue('@cf/qwen/qwen3-30b-a3b-fp8');

    // Switch to scaleway
    await page.getByTestId('opencode-provider-select').selectOption('scaleway');
    await page.waitForTimeout(300);
    await takeScreenshot(page, 'agent-settings-mobile-switch-from-platform');
    await assertNoOverflow(page);

    // After switch: model input is text and empty (cleared)
    const modelAfter = page.getByTestId('model-input-opencode');
    const tagAfter = await modelAfter.evaluate((el) => el.tagName.toLowerCase());
    expect(tagAfter).toBe('input');
    await expect(modelAfter).toHaveValue('');
  });

  test('non-OpenCode agent: shows text input only, no provider selector', async ({ page }) => {
    await setupApiMocks(page, {
      agents: [MOCK_AGENT_CLAUDE],
      settingsMap: {},
    });
    await navigateToAgentConfig(page);
    await page.waitForSelector('[data-testid="agent-settings-claude-code"]');
    await takeScreenshot(page, 'agent-settings-mobile-claude-code');
    await assertNoOverflow(page);

    // No provider selector present
    await expect(page.getByTestId('opencode-provider-select')).not.toBeVisible();

    // Model is text input
    const modelInput = page.getByTestId('model-input-claude-code');
    await expect(modelInput).toBeVisible();
    const tagName = await modelInput.evaluate((el) => el.tagName.toLowerCase());
    expect(tagName).toBe('input');
  });

  test('multiple agents rendered: layout holds on mobile', async ({ page }) => {
    await setupApiMocks(page, {
      agents: [MOCK_AGENT_OPENCODE, MOCK_AGENT_CLAUDE, MOCK_AGENT_CODEX],
      settingsMap: {
        opencode: makeSettings({ opencodeProvider: 'platform' }),
      },
    });
    await navigateToAgentConfig(page);
    await page.waitForSelector('[data-testid="agent-settings-opencode"]');
    await page.waitForSelector('[data-testid="agent-settings-claude-code"]');
    await takeScreenshot(page, 'agent-settings-mobile-multiple-agents');
    await assertNoOverflow(page);
  });

  test('custom provider: shows base URL and provider name fields', async ({ page }) => {
    await setupApiMocks(page, {
      agents: [MOCK_AGENT_OPENCODE],
      settingsMap: {
        opencode: makeSettings({
          opencodeProvider: 'custom',
          opencodeBaseUrl: 'https://api.my-custom-llm.com/v1',
          opencodeProviderName: 'My Custom LLM',
          model: 'custom-model-v1',
        }),
      },
    });
    await navigateToAgentConfig(page);
    await page.waitForSelector('[data-testid="agent-settings-opencode"]');
    await takeScreenshot(page, 'agent-settings-mobile-custom-provider');
    await assertNoOverflow(page);

    await expect(page.getByTestId('opencode-base-url-input')).toBeVisible();
    await expect(page.getByTestId('opencode-provider-name-input')).toBeVisible();

    // Model is a text input (not select) for custom provider
    const modelInput = page.getByTestId('model-input-opencode');
    const tagName = await modelInput.evaluate((el) => el.tagName.toLowerCase());
    expect(tagName).toBe('input');
  });

  test('API error loading agents: shows error state', async ({ page }) => {
    await setupApiMocks(page, { agentsError: true });
    await navigateToAgentConfig(page);
    await page.waitForTimeout(1000);
    await takeScreenshot(page, 'agent-settings-mobile-agents-error');
    await assertNoOverflow(page);
  });

  test('platform provider: model select has all expected options', async ({ page }) => {
    await setupApiMocks(page, {
      agents: [MOCK_AGENT_OPENCODE],
      settingsMap: {
        opencode: makeSettings({ opencodeProvider: 'platform' }),
      },
    });
    await navigateToAgentConfig(page);
    await page.waitForSelector('[data-testid="agent-settings-opencode"]');

    const modelSelect = page.getByTestId('model-input-opencode');
    await expect(modelSelect).toBeVisible();

    const optionValues = await modelSelect.evaluate((el) => {
      const select = el as HTMLSelectElement;
      return Array.from(select.options).map((o) => o.value);
    });
    // Empty string value for the default option
    expect(optionValues).toContain('');
    // All three platform models must be present
    expect(optionValues).toContain('@cf/meta/llama-4-scout-17b-16e-instruct');
    expect(optionValues).toContain('@cf/qwen/qwen3-30b-a3b-fp8');
    expect(optionValues).toContain('@cf/google/gemma-3-12b-it');

    await takeScreenshot(page, 'agent-settings-mobile-platform-model-select-options');
    await assertNoOverflow(page);
  });

  test('label association: model label htmlFor links to model control id', async ({ page }) => {
    await setupApiMocks(page, {
      agents: [MOCK_AGENT_OPENCODE],
      settingsMap: {
        opencode: makeSettings({ opencodeProvider: 'platform' }),
      },
    });
    await navigateToAgentConfig(page);
    await page.waitForSelector('[data-testid="agent-settings-opencode"]');

    // The <label> htmlFor must match the model control's id
    const labelFor = await page.evaluate(() => {
      const allLabels = Array.from(document.querySelectorAll('label'));
      const modelLabel = allLabels.find((l) => l.textContent?.trim() === 'Model');
      return modelLabel?.htmlFor ?? null;
    });
    const controlId = await page.getByTestId('model-input-opencode').getAttribute('id');
    expect(labelFor).not.toBeNull();
    expect(labelFor).toBe(controlId);
  });

  test('label association: inference provider label links to provider select', async ({ page }) => {
    await setupApiMocks(page, {
      agents: [MOCK_AGENT_OPENCODE],
      settingsMap: {},
    });
    await navigateToAgentConfig(page);
    await page.waitForSelector('[data-testid="agent-settings-opencode"]');

    const labelFor = await page.evaluate(() => {
      const allLabels = Array.from(document.querySelectorAll('label'));
      const providerLabel = allLabels.find((l) => l.textContent?.trim() === 'Inference Provider');
      return providerLabel?.htmlFor ?? null;
    });
    const selectId = await page.getByTestId('opencode-provider-select').getAttribute('id');
    expect(labelFor).not.toBeNull();
    expect(labelFor).toBe(selectId);
  });

  test('focus ring: focus-visible:outline classes are applied to model select', async ({ page }) => {
    await setupApiMocks(page, {
      agents: [MOCK_AGENT_OPENCODE],
      settingsMap: {
        opencode: makeSettings({ opencodeProvider: 'platform' }),
      },
    });
    await navigateToAgentConfig(page);
    await page.waitForSelector('[data-testid="agent-settings-opencode"]');

    // Verify the model select has the correct focus-visible Tailwind classes applied.
    // outline-none removes the browser default; focus-visible:outline restores a custom
    // ring from the design system token --sam-color-focus-ring when keyboard-focused.
    const modelSelectClass = await page.getByTestId('model-input-opencode').getAttribute('class');
    expect(modelSelectClass).toContain('outline-none');
    expect(modelSelectClass).toContain('focus-visible:outline');
    expect(modelSelectClass).toContain('focus-visible:outline-2');
    expect(modelSelectClass).toContain('focus-visible:outline-focus-ring');

    // Same check on the provider select
    const providerSelectClass = await page.getByTestId('opencode-provider-select').getAttribute('class');
    expect(providerSelectClass).toContain('focus-visible:outline');
    expect(providerSelectClass).toContain('focus-visible:outline-focus-ring');

    await takeScreenshot(page, 'agent-settings-mobile-focus-ring-platform-select');
    await assertNoOverflow(page);
  });

  test('touch target: model select meets 44px minimum height', async ({ page }) => {
    await setupApiMocks(page, {
      agents: [MOCK_AGENT_OPENCODE],
      settingsMap: {
        opencode: makeSettings({ opencodeProvider: 'platform' }),
      },
    });
    await navigateToAgentConfig(page);
    await page.waitForSelector('[data-testid="agent-settings-opencode"]');

    const modelSelect = page.getByTestId('model-input-opencode');
    await expect(modelSelect).toBeVisible();
    const box = await modelSelect.boundingBox();
    expect(box).not.toBeNull();
    // min-h-11 in Tailwind = 44px (11 * 4px = 44px)
    expect(box!.height).toBeGreaterThanOrEqual(44);
  });

  test('touch target: save button meets 44px minimum height', async ({ page }) => {
    await setupApiMocks(page, {
      agents: [MOCK_AGENT_OPENCODE],
      settingsMap: {
        opencode: makeSettings({ opencodeProvider: 'platform' }),
      },
    });
    await navigateToAgentConfig(page);
    await page.waitForSelector('[data-testid="agent-settings-opencode"]');

    const saveButton = page.getByTestId('save-settings-opencode');
    await expect(saveButton).toBeVisible();
    const box = await saveButton.boundingBox();
    expect(box).not.toBeNull();
    // Save button uses min-h-[44px] — meets the 44px WCAG touch target minimum
    expect(box!.height).toBeGreaterThanOrEqual(44);
  });

  test('bypassPermissions warning: visible, non-color-only cue', async ({ page }) => {
    await setupApiMocks(page, {
      agents: [MOCK_AGENT_OPENCODE],
      settingsMap: {
        opencode: makeSettings({ permissionMode: 'bypassPermissions' }),
      },
    });
    await navigateToAgentConfig(page);
    await page.waitForSelector('[data-testid="agent-settings-opencode"]');
    await takeScreenshot(page, 'agent-settings-mobile-bypass-warning');
    await assertNoOverflow(page);

    // Warning has role="alert" for screen reader announcement
    const warningEl = page.locator('[role="alert"]');
    await expect(warningEl).toBeVisible();

    // Warning text must contain non-color cue (the warning symbol prefix)
    const warningText = await warningEl.textContent();
    expect(warningText).toContain('Warning');
  });

  test('platform provider: default option label shows default model name', async ({ page }) => {
    await setupApiMocks(page, {
      agents: [MOCK_AGENT_OPENCODE],
      settingsMap: {
        opencode: makeSettings({ opencodeProvider: 'platform', model: '' }),
      },
    });
    await navigateToAgentConfig(page);
    await page.waitForSelector('[data-testid="agent-settings-opencode"]');

    const defaultOptionText = await page.getByTestId('model-input-opencode').evaluate((el) => {
      const select = el as HTMLSelectElement;
      const firstOption = select.options[0];
      return firstOption ? firstOption.textContent : null;
    });
    // Default option should name the default model (Llama 4 Scout 17B)
    expect(defaultOptionText).toContain('Llama 4 Scout 17B');
    await takeScreenshot(page, 'agent-settings-mobile-platform-default-option');
  });

  test('openai-compatible provider: shows base URL but no provider name field', async ({ page }) => {
    await setupApiMocks(page, {
      agents: [MOCK_AGENT_OPENCODE],
      settingsMap: {
        opencode: makeSettings({
          opencodeProvider: 'openai-compatible',
          opencodeBaseUrl: 'https://api.mistral.ai/v1',
        }),
      },
    });
    await navigateToAgentConfig(page);
    await page.waitForSelector('[data-testid="agent-settings-opencode"]');
    await takeScreenshot(page, 'agent-settings-mobile-openai-compatible');
    await assertNoOverflow(page);

    // Base URL shown
    await expect(page.getByTestId('opencode-base-url-input')).toBeVisible();

    // Provider name NOT shown (only for 'custom')
    await expect(page.getByTestId('opencode-provider-name-input')).not.toBeVisible();
  });
});

// ===========================================================================
// AGENT SETTINGS — Desktop (1280x800)
// ===========================================================================

test.describe('AgentSettingsSection — Desktop', () => {
  test.use({ viewport: { width: 1280, height: 800 }, isMobile: false });

  test('platform provider renders correctly on desktop', async ({ page }) => {
    await setupApiMocks(page, {
      agents: [MOCK_AGENT_OPENCODE],
      settingsMap: {
        opencode: makeSettings({ opencodeProvider: 'platform', model: '@cf/meta/llama-4-scout-17b-16e-instruct' }),
      },
    });
    await navigateToAgentConfig(page);
    await page.waitForSelector('[data-testid="agent-settings-opencode"]');
    await takeScreenshot(page, 'agent-settings-desktop-platform-provider');
    await assertNoOverflow(page);

    const modelSelect = page.getByTestId('model-input-opencode');
    await expect(modelSelect).toBeVisible();
    await expect(modelSelect).toHaveValue('@cf/meta/llama-4-scout-17b-16e-instruct');
  });

  test('all providers: layout holds on desktop for each provider', async ({ page }) => {
    const providers = ['platform', 'scaleway', 'google-vertex', 'anthropic', 'custom', 'openai-compatible'];
    for (const provider of providers) {
      await setupApiMocks(page, {
        agents: [MOCK_AGENT_OPENCODE],
        settingsMap: {
          opencode: makeSettings({ opencodeProvider: provider as never }),
        },
      });
      await navigateToAgentConfig(page);
      await page.waitForSelector('[data-testid="agent-settings-opencode"]');
      await takeScreenshot(page, `agent-settings-desktop-provider-${provider}`);
      await assertNoOverflow(page);
    }
  });

  test('multiple agents: all cards render without overflow on desktop', async ({ page }) => {
    await setupApiMocks(page, {
      agents: [MOCK_AGENT_OPENCODE, MOCK_AGENT_CLAUDE, MOCK_AGENT_CODEX],
      settingsMap: {
        opencode: makeSettings({ opencodeProvider: 'platform' }),
      },
    });
    await navigateToAgentConfig(page);
    await page.waitForSelector('[data-testid="agent-settings-opencode"]');
    await takeScreenshot(page, 'agent-settings-desktop-multiple-agents');
    await assertNoOverflow(page);
  });

  test('provider select label association on desktop', async ({ page }) => {
    await setupApiMocks(page, {
      agents: [MOCK_AGENT_OPENCODE],
      settingsMap: {
        opencode: makeSettings({ opencodeProvider: 'platform' }),
      },
    });
    await navigateToAgentConfig(page);
    await page.waitForSelector('[data-testid="agent-settings-opencode"]');

    const labelFor = await page.evaluate(() => {
      const allLabels = Array.from(document.querySelectorAll('label'));
      const label = allLabels.find((l) => l.textContent?.trim() === 'Inference Provider');
      return label?.htmlFor ?? null;
    });
    const selectId = await page.getByTestId('opencode-provider-select').getAttribute('id');
    expect(labelFor).toBe(selectId);
    expect(selectId).toBeTruthy();
  });

  test('model label links to model control on desktop (platform mode)', async ({ page }) => {
    await setupApiMocks(page, {
      agents: [MOCK_AGENT_OPENCODE],
      settingsMap: {
        opencode: makeSettings({ opencodeProvider: 'platform' }),
      },
    });
    await navigateToAgentConfig(page);
    await page.waitForSelector('[data-testid="agent-settings-opencode"]');

    const labelFor = await page.evaluate(() => {
      const allLabels = Array.from(document.querySelectorAll('label'));
      const label = allLabels.find((l) => l.textContent?.trim() === 'Model');
      return label?.htmlFor ?? null;
    });
    const controlId = await page.getByTestId('model-input-opencode').getAttribute('id');
    expect(labelFor).toBe(controlId);
  });

  test('error state: agents API error renders without overflow', async ({ page }) => {
    await setupApiMocks(page, { agentsError: true });
    await navigateToAgentConfig(page);
    await page.waitForTimeout(1000);
    await takeScreenshot(page, 'agent-settings-desktop-error');
    await assertNoOverflow(page);
  });
});
