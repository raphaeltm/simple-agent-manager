/**
 * Knowledge Browser UI Audit
 * Covers: normal data, long text, empty state, many items, special chars
 * Viewports: iPhone SE 375x667 (mobile), Desktop 1280x800
 */
import { expect, type Page, type Route, test } from '@playwright/test';

// ---------------------------------------------------------------------------
// Shared mock data
// ---------------------------------------------------------------------------

const MOCK_USER = {
  user: {
    id: 'user-1',
    email: 'test@example.com',
    name: 'Test User',
    image: null,
    role: 'user',
    status: 'active',
    emailVerified: true,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
  session: {
    id: 'session-1',
    userId: 'user-1',
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    token: 'mock-token',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
};

const MOCK_PROJECT = {
  id: 'proj-1',
  name: 'Test Project',
  repository: 'testuser/test-repo',
  defaultBranch: 'main',
  userId: 'user-1',
  githubInstallationId: 'inst-1',
  defaultVmSize: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

// ---------------------------------------------------------------------------
// Knowledge data factories
// ---------------------------------------------------------------------------

function makeEntity(overrides: Partial<{
  id: string;
  name: string;
  entityType: string;
  description: string | null;
  observationCount: number;
  confidence: number;
  updatedAt: string;
}> = {}) {
  return {
    id: overrides.id ?? 'entity-1',
    projectId: 'proj-1',
    name: overrides.name ?? 'CodeStyle',
    entityType: overrides.entityType ?? 'preference',
    description: overrides.description ?? 'Prefers concise, strongly-typed code.',
    observationCount: overrides.observationCount ?? 3,
    confidence: overrides.confidence ?? 0.85,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: overrides.updatedAt ?? '2026-04-10T00:00:00Z',
  };
}

function makeObservation(overrides: Partial<{
  id: string;
  entityId: string;
  content: string;
  sourceType: string;
  confidence: number;
}> = {}) {
  return {
    id: overrides.id ?? 'obs-1',
    entityId: overrides.entityId ?? 'entity-1',
    content: overrides.content ?? 'Prefers TypeScript strict mode.',
    sourceType: overrides.sourceType ?? 'explicit',
    confidence: overrides.confidence ?? 0.9,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
}

// ---------------------------------------------------------------------------
// Data sets
// ---------------------------------------------------------------------------

const NORMAL_ENTITIES = [
  makeEntity({ id: 'e1', name: 'CodeStyle', entityType: 'preference', description: 'Prefers concise, strongly-typed code.', observationCount: 3 }),
  makeEntity({ id: 'e2', name: 'TechExpertise', entityType: 'expertise', description: 'Deep knowledge of TypeScript and React.', observationCount: 5 }),
  makeEntity({ id: 'e3', name: 'Communication', entityType: 'style', description: 'Prefers direct, concise answers.', observationCount: 2 }),
];

const NORMAL_ENTITY_DETAIL = {
  entity: { ...makeEntity({ id: 'e1' }), relationsCount: 1 },
  observations: [
    makeObservation({ id: 'obs-1', content: 'Prefers TypeScript strict mode.' }),
    makeObservation({ id: 'obs-2', content: 'Uses Tailwind for styling.', sourceType: 'inferred', confidence: 0.7 }),
    makeObservation({ id: 'obs-3', content: 'Prefers functional components.', sourceType: 'behavioral', confidence: 0.6 }),
  ],
  relations: [
    { id: 'rel-1', fromEntityId: 'e1', toEntityId: 'e2', relationType: 'related_to', description: 'Overlaps with expertise' },
  ],
};

const LONG_TEXT_ENTITIES = [
  makeEntity({
    id: 'lt1',
    name: 'A'.repeat(80),
    entityType: 'context',
    description: 'B'.repeat(300),
    observationCount: 10,
  }),
  makeEntity({
    id: 'lt2',
    name: 'Very Long Entity Name That Should Wrap Or Truncate Nicely In The Card Layout Even On Narrow Mobile',
    entityType: 'workflow',
    description: 'This is an extremely detailed description that goes on and on, describing preferences, quirks, workflows, and historical context that the knowledge graph has accumulated over many interactions.',
    observationCount: 15,
  }),
];

const LONG_TEXT_DETAIL = {
  entity: { ...makeEntity({ id: 'lt1', name: 'A'.repeat(80), description: 'B'.repeat(300) }), relationsCount: 0 },
  observations: [
    makeObservation({ id: 'lo1', content: 'C'.repeat(400) }),
    makeObservation({ id: 'lo2', content: 'Observation with a very long sentence that should break correctly within the observation card and not overflow at any viewport size including 320px.', sourceType: 'inferred', confidence: 0.5 }),
  ],
  relations: [],
};

const MANY_ENTITIES = Array.from({ length: 35 }, (_, i) =>
  makeEntity({
    id: `me${i}`,
    name: `Entity ${i + 1}`,
    entityType: ['preference', 'style', 'context', 'expertise', 'workflow', 'personality', 'custom'][i % 7],
    description: i % 3 === 0 ? null : `Description for entity ${i + 1}`,
    observationCount: i % 5,
  }),
);

const SPECIAL_CHAR_ENTITIES = [
  makeEntity({ id: 'sc1', name: '日本語テスト 🧠', entityType: 'custom', description: '<script>alert("xss")</script>' }),
  makeEntity({ id: 'sc2', name: 'Em Dash — & Ampersand', entityType: 'preference', description: 'A "quoted" description with <html> entities & special chars.' }),
];

// ---------------------------------------------------------------------------
// Route setup — mirrors the comprehensive mock used in ideas-ui-audit
// ---------------------------------------------------------------------------

async function setupApiMocks(page: Page, options: {
  entities?: ReturnType<typeof makeEntity>[];
  detail?: typeof NORMAL_ENTITY_DETAIL | null;
} = {}) {
  const { entities = NORMAL_ENTITIES, detail = null } = options;

  await page.route('**/api/**', async (route: Route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const respond = (status: number, body: unknown) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

    // Auth — BetterAuth uses /api/auth/session
    if (path.includes('/api/auth/')) {
      return respond(200, MOCK_USER);
    }

    // Better-auth client also hits /api/auth/get-session
    if (url.hostname === 'localhost' && path === '/api/auth/get-session') {
      return respond(200, MOCK_USER);
    }

    // Dashboard
    if (path === '/api/dashboard/active-tasks') {
      return respond(200, { tasks: [] });
    }

    // GitHub
    if (path === '/api/github/installations') {
      return respond(200, []);
    }

    // Notifications
    if (path.startsWith('/api/notifications')) {
      return respond(200, { notifications: [], unreadCount: 0 });
    }

    // Agents
    if (path === '/api/agents') {
      return respond(200, []);
    }

    // Credentials
    if (path.startsWith('/api/credentials')) {
      return respond(200, { credentials: [] });
    }

    // Projects list
    if (path === '/api/projects') {
      return respond(200, { projects: [MOCK_PROJECT] });
    }

    // Project-scoped routes
    const projectMatch = path.match(/^\/api\/projects\/([^/]+)(\/.*)?$/);
    if (projectMatch) {
      const subPath = projectMatch[2] || '';

      // Knowledge entity detail
      if (subPath.match(/^\/knowledge\/[^/]+$/) && !subPath.includes('/observations')) {
        if (detail) {
          return respond(200, detail);
        }
        return respond(404, { error: 'Not found' });
      }

      // Observations
      if (subPath.match(/^\/knowledge\/[^/]+\/observations/)) {
        return respond(200, { id: 'new-obs', createdAt: Date.now() });
      }

      // Knowledge list
      if (subPath === '/knowledge' || subPath.startsWith('/knowledge?')) {
        return respond(200, { entities, total: entities.length });
      }

      // Sessions
      if (subPath.startsWith('/sessions')) {
        return respond(200, { sessions: [], total: 0 });
      }

      // Tasks
      if (subPath === '/tasks' || subPath.startsWith('/tasks?')) {
        return respond(200, { tasks: [], nextCursor: null });
      }

      // Activity
      if (subPath.startsWith('/activity')) {
        return respond(200, { events: [], hasMore: false });
      }

      // Project detail
      if (!subPath || subPath === '/') {
        return respond(200, MOCK_PROJECT);
      }

      // Catch-all for other project sub-routes
      return respond(200, {});
    }

    // Fallback
    return respond(200, {});
  });
}

async function screenshot(page: Page, name: string) {
  await page.waitForTimeout(700);
  await page.screenshot({
    path: `/workspaces/sam-knowledge-graph/.codex/tmp/playwright-screenshots/${name}.png`,
    fullPage: true,
  });
}

// ---------------------------------------------------------------------------
// Mobile tests (375x667)
// ---------------------------------------------------------------------------

test.describe('Knowledge Browser — Mobile (375x667)', () => {
  test.use({ viewport: { width: 375, height: 667 }, isMobile: true, hasTouch: true });

  test('normal data — list view', async ({ page }) => {
    await setupApiMocks(page, { entities: NORMAL_ENTITIES });
    await page.goto('http://localhost:4173/projects/proj-1/knowledge');
    await page.waitForSelector('text=Knowledge', { timeout: 12000 });
    await screenshot(page, 'knowledge-normal-mobile');

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(overflow).toBe(false);
  });

  test('entity detail — mobile full-screen', async ({ page }) => {
    await setupApiMocks(page, { entities: NORMAL_ENTITIES, detail: NORMAL_ENTITY_DETAIL });
    await page.goto('http://localhost:4173/projects/proj-1/knowledge');
    await page.waitForSelector('text=CodeStyle', { timeout: 12000 });
    await page.click('text=CodeStyle');
    await page.waitForTimeout(600);
    await screenshot(page, 'knowledge-detail-mobile');

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(overflow).toBe(false);
  });

  test('empty state', async ({ page }) => {
    await setupApiMocks(page, { entities: [] });
    await page.goto('http://localhost:4173/projects/proj-1/knowledge');
    await page.waitForSelector('text=Knowledge', { timeout: 12000 });
    await screenshot(page, 'knowledge-empty-mobile');

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(overflow).toBe(false);
  });

  test('long text — wraps without overflow', async ({ page }) => {
    await setupApiMocks(page, { entities: LONG_TEXT_ENTITIES, detail: LONG_TEXT_DETAIL });
    await page.goto('http://localhost:4173/projects/proj-1/knowledge');
    await page.waitForSelector('text=Knowledge', { timeout: 12000 });
    await screenshot(page, 'knowledge-long-text-mobile');

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(overflow).toBe(false);
  });

  test('long text detail — observations wrap', async ({ page }) => {
    await setupApiMocks(page, { entities: LONG_TEXT_ENTITIES, detail: LONG_TEXT_DETAIL });
    await page.goto('http://localhost:4173/projects/proj-1/knowledge');
    await page.waitForSelector('text=Knowledge', { timeout: 12000 });
    // Click first entity card
    await page.locator('[class*="cursor-pointer"]').first().click();
    await page.waitForTimeout(600);
    await screenshot(page, 'knowledge-long-text-detail-mobile');

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(overflow).toBe(false);
  });

  test('many items (35) — scroll, no overflow', async ({ page }) => {
    await setupApiMocks(page, { entities: MANY_ENTITIES });
    await page.goto('http://localhost:4173/projects/proj-1/knowledge');
    await page.waitForSelector('text=Knowledge', { timeout: 12000 });
    await screenshot(page, 'knowledge-many-mobile');

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(overflow).toBe(false);
  });

  test('special characters — no XSS, no overflow', async ({ page }) => {
    const dialogs: string[] = [];
    page.on('dialog', (d) => { dialogs.push(d.message()); void d.dismiss(); });

    await setupApiMocks(page, { entities: SPECIAL_CHAR_ENTITIES });
    await page.goto('http://localhost:4173/projects/proj-1/knowledge');
    await page.waitForSelector('text=Knowledge', { timeout: 12000 });
    await screenshot(page, 'knowledge-special-chars-mobile');

    expect(dialogs).toHaveLength(0);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(overflow).toBe(false);
  });

  test('create form — renders and no overflow', async ({ page }) => {
    await setupApiMocks(page, { entities: NORMAL_ENTITIES });
    await page.goto('http://localhost:4173/projects/proj-1/knowledge');
    await page.waitForSelector('text=Add Entity', { timeout: 12000 });
    await page.click('text=Add Entity');
    await page.waitForTimeout(400);
    await screenshot(page, 'knowledge-create-form-mobile');

    // Measure primary CTA height
    const createBtnHeight = await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Create');
      return btn ? btn.getBoundingClientRect().height : 0;
    });
    console.log(`[audit] Create button height on mobile: ${createBtnHeight}px`);

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(overflow).toBe(false);
  });

  test('filter chips — wrap without overflow at 375px', async ({ page }) => {
    await setupApiMocks(page, { entities: NORMAL_ENTITIES });
    await page.goto('http://localhost:4173/projects/proj-1/knowledge');
    await page.waitForSelector('text=Knowledge', { timeout: 12000 });
    // Scroll to show filter chips area
    await page.waitForTimeout(400);
    await screenshot(page, 'knowledge-filter-chips-mobile');

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(overflow).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Desktop tests (1280x800)
// ---------------------------------------------------------------------------

test.describe('Knowledge Browser — Desktop (1280x800)', () => {
  test.use({ viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false });

  test('normal data — list only (no selection)', async ({ page }) => {
    await setupApiMocks(page, { entities: NORMAL_ENTITIES });
    await page.goto('http://localhost:4173/projects/proj-1/knowledge');
    await page.waitForSelector('text=Knowledge', { timeout: 12000 });
    await screenshot(page, 'knowledge-normal-list-desktop');

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(overflow).toBe(false);
  });

  test('split panel — entity selected shows detail', async ({ page }) => {
    await setupApiMocks(page, { entities: NORMAL_ENTITIES, detail: NORMAL_ENTITY_DETAIL });
    await page.goto('http://localhost:4173/projects/proj-1/knowledge');
    await page.waitForSelector('text=CodeStyle', { timeout: 12000 });
    await page.click('text=CodeStyle');
    await page.waitForTimeout(600);
    await screenshot(page, 'knowledge-split-panel-desktop');

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(overflow).toBe(false);
  });

  test('empty state', async ({ page }) => {
    await setupApiMocks(page, { entities: [] });
    await page.goto('http://localhost:4173/projects/proj-1/knowledge');
    await page.waitForSelector('text=Knowledge', { timeout: 12000 });
    await screenshot(page, 'knowledge-empty-desktop');

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(overflow).toBe(false);
  });

  test('long text — entity names and observations wrap', async ({ page }) => {
    await setupApiMocks(page, { entities: LONG_TEXT_ENTITIES, detail: LONG_TEXT_DETAIL });
    await page.goto('http://localhost:4173/projects/proj-1/knowledge');
    await page.waitForSelector('text=Knowledge', { timeout: 12000 });
    await page.locator('[class*="cursor-pointer"]').first().click();
    await page.waitForTimeout(600);
    await screenshot(page, 'knowledge-long-text-desktop');

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(overflow).toBe(false);
  });

  test('many items (35)', async ({ page }) => {
    await setupApiMocks(page, { entities: MANY_ENTITIES });
    await page.goto('http://localhost:4173/projects/proj-1/knowledge');
    await page.waitForSelector('text=Knowledge', { timeout: 12000 });
    await screenshot(page, 'knowledge-many-desktop');

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(overflow).toBe(false);
  });

  test('create form — visible and no overflow', async ({ page }) => {
    await setupApiMocks(page, { entities: NORMAL_ENTITIES });
    await page.goto('http://localhost:4173/projects/proj-1/knowledge');
    await page.waitForSelector('text=Add Entity', { timeout: 12000 });
    await page.click('text=Add Entity');
    await page.waitForTimeout(400);
    await screenshot(page, 'knowledge-create-form-desktop');

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(overflow).toBe(false);
  });

  test('special characters — XSS safe', async ({ page }) => {
    const dialogs: string[] = [];
    page.on('dialog', (d) => { dialogs.push(d.message()); void d.dismiss(); });

    await setupApiMocks(page, { entities: SPECIAL_CHAR_ENTITIES });
    await page.goto('http://localhost:4173/projects/proj-1/knowledge');
    await page.waitForSelector('text=Knowledge', { timeout: 12000 });
    await screenshot(page, 'knowledge-special-chars-desktop');

    expect(dialogs).toHaveLength(0);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(overflow).toBe(false);
  });

  test('keyboard nav — filter chips reachable by Tab', async ({ page }) => {
    await setupApiMocks(page, { entities: NORMAL_ENTITIES });
    await page.goto('http://localhost:4173/projects/proj-1/knowledge');
    await page.waitForSelector('text=Knowledge', { timeout: 12000 });
    // Tab from page body to reach filter area
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await page.waitForTimeout(300);
    await screenshot(page, 'knowledge-keyboard-focus-desktop');
  });
});
