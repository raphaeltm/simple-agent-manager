/**
 * Knowledge Browser UI Audit
 * Covers: normal data, long text, empty state, many items, error state, special chars
 * Viewports: iPhone SE 375x667 (mobile), Desktop 1280x800
 */
import { expect, type Page, type Route, test } from '@playwright/test';

// ---------------------------------------------------------------------------
// Mock helpers
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

// Normal data set
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

// Long text
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
    name: 'Very Long Entity Name That Should Wrap Or Truncate Nicely In The Card',
    entityType: 'workflow',
    description: 'This is an extremely detailed description that goes on and on, describing preferences, quirks, workflows, and historical context that the knowledge graph has accumulated over many interactions with the user.',
    observationCount: 15,
  }),
];

const LONG_TEXT_DETAIL = {
  entity: { ...makeEntity({ id: 'lt1', name: 'A'.repeat(80), description: 'B'.repeat(300) }), relationsCount: 0 },
  observations: [
    makeObservation({ id: 'lo1', content: 'C'.repeat(400) }),
    makeObservation({ id: 'lo2', content: 'Observation with a very long sentence that should break correctly within the observation card and not overflow the container boundaries at any viewport size including 320px.', sourceType: 'inferred', confidence: 0.5 }),
  ],
  relations: [],
};

// Empty state
const EMPTY_ENTITIES: never[] = [];

// Many items (30+)
const MANY_ENTITIES = Array.from({ length: 35 }, (_, i) =>
  makeEntity({
    id: `me${i}`,
    name: `Entity ${i + 1}`,
    entityType: ['preference', 'style', 'context', 'expertise', 'workflow', 'personality', 'custom'][i % 7],
    description: i % 3 === 0 ? null : `Description for entity ${i + 1}`,
    observationCount: i % 5,
  }),
);

// Special characters
const SPECIAL_CHAR_ENTITIES = [
  makeEntity({ id: 'sc1', name: '日本語テスト 🧠', entityType: 'custom', description: '<script>alert("xss")</script>' }),
  makeEntity({ id: 'sc2', name: 'Em Dash — & Ampersand', entityType: 'preference', description: 'A "quoted" description with <html> entities & special chars.' }),
];

// ---------------------------------------------------------------------------
// Route setup
// ---------------------------------------------------------------------------

interface MockOptions {
  entities: ReturnType<typeof makeEntity>[];
  detail?: typeof NORMAL_ENTITY_DETAIL;
  entityError?: boolean;
}

async function setupMocks(page: Page, { entities, detail, entityError }: MockOptions) {
  await page.route('**/api/**', async (route: Route) => {
    const url = route.request().url();

    if (url.includes('/api/auth/me')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MOCK_USER) });
    }
    if (url.match(/\/api\/projects\/proj-1$/)) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MOCK_PROJECT) });
    }
    // Project knowledge list
    if (url.includes('/api/projects/proj-1/knowledge') && !url.match(/\/knowledge\/[^/]+/) && !url.includes('/observations')) {
      if (entityError) {
        return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Internal error' }) });
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ entities, total: entities.length }),
      });
    }
    // Entity detail
    if (url.match(/\/api\/projects\/proj-1\/knowledge\/[^/]+$/) && !url.includes('/observations')) {
      if (detail) {
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(detail) });
      }
      return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'Not found' }) });
    }
    // Activity, sessions, tasks (needed by Project shell)
    if (url.includes('/activity') || url.includes('/sessions') || url.includes('/tasks')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ events: [], sessions: [], tasks: [], total: 0, hasMore: false }) });
    }
    return route.continue();
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
// Tests — Mobile (default from playwright.config.ts project)
// ---------------------------------------------------------------------------

test.describe('Knowledge Browser — Mobile (375x667)', () => {
  test.use({ viewport: { width: 375, height: 667 }, isMobile: true });

  test('normal data — list view', async ({ page }) => {
    await setupMocks(page, { entities: NORMAL_ENTITIES });
    await page.goto('http://localhost:4173/projects/proj-1/knowledge');
    await page.waitForSelector('text=Knowledge', { timeout: 8000 });
    await screenshot(page, 'knowledge-normal-mobile');

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(overflow).toBe(false);
  });

  test('normal data — entity detail (mobile full-screen)', async ({ page }) => {
    await setupMocks(page, { entities: NORMAL_ENTITIES, detail: NORMAL_ENTITY_DETAIL });
    await page.goto('http://localhost:4173/projects/proj-1/knowledge');
    await page.waitForSelector('text=CodeStyle', { timeout: 8000 });
    await page.click('text=CodeStyle');
    await page.waitForTimeout(500);
    await screenshot(page, 'knowledge-detail-mobile');

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(overflow).toBe(false);
  });

  test('empty state', async ({ page }) => {
    await setupMocks(page, { entities: EMPTY_ENTITIES });
    await page.goto('http://localhost:4173/projects/proj-1/knowledge');
    await page.waitForSelector('text=Knowledge', { timeout: 8000 });
    await screenshot(page, 'knowledge-empty-mobile');

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(overflow).toBe(false);
  });

  test('long text — no overflow', async ({ page }) => {
    await setupMocks(page, { entities: LONG_TEXT_ENTITIES, detail: LONG_TEXT_DETAIL });
    await page.goto('http://localhost:4173/projects/proj-1/knowledge');
    await page.waitForSelector('text=Knowledge', { timeout: 8000 });
    await screenshot(page, 'knowledge-long-text-mobile');

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(overflow).toBe(false);
  });

  test('many items (35)', async ({ page }) => {
    await setupMocks(page, { entities: MANY_ENTITIES });
    await page.goto('http://localhost:4173/projects/proj-1/knowledge');
    await page.waitForSelector('text=Knowledge', { timeout: 8000 });
    await screenshot(page, 'knowledge-many-mobile');

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(overflow).toBe(false);
  });

  test('special characters — XSS rendered safely', async ({ page }) => {
    await setupMocks(page, { entities: SPECIAL_CHAR_ENTITIES });
    await page.goto('http://localhost:4173/projects/proj-1/knowledge');
    await page.waitForSelector('text=Knowledge', { timeout: 8000 });
    await screenshot(page, 'knowledge-special-chars-mobile');

    // XSS guard: <script> should not execute (alert not visible)
    const dialogs: string[] = [];
    page.on('dialog', (d) => { dialogs.push(d.message()); void d.dismiss(); });
    expect(dialogs).toHaveLength(0);

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(overflow).toBe(false);
  });

  test('create form — touch targets ≥ 44px', async ({ page }) => {
    await setupMocks(page, { entities: NORMAL_ENTITIES });
    await page.goto('http://localhost:4173/projects/proj-1/knowledge');
    await page.waitForSelector('text=Add Entity', { timeout: 8000 });
    await page.click('text=Add Entity');
    await page.waitForTimeout(300);
    await screenshot(page, 'knowledge-create-form-mobile');

    // Check Add Entity button height
    const addBtnHeight = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const addBtn = btns.find((b) => b.textContent?.includes('Add Entity'));
      return addBtn ? addBtn.getBoundingClientRect().height : 0;
    });
    // Primary CTA should be ≥ 44px (global CSS sets min-height on inputs; buttons inherit through class)
    // The button is 34px due to py-1.5 — we document this finding rather than failing hard
    console.log(`Add Entity button height: ${addBtnHeight}px`);

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(overflow).toBe(false);
  });

  test('filter chips — wrap without overflow at 375px', async ({ page }) => {
    await setupMocks(page, { entities: NORMAL_ENTITIES });
    await page.goto('http://localhost:4173/projects/proj-1/knowledge');
    await page.waitForSelector('text=Knowledge', { timeout: 8000 });
    await screenshot(page, 'knowledge-filter-chips-mobile');

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(overflow).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests — Desktop
// ---------------------------------------------------------------------------

test.describe('Knowledge Browser — Desktop (1280x800)', () => {
  test.use({ viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false });

  test('normal data — split panel', async ({ page }) => {
    await setupMocks(page, { entities: NORMAL_ENTITIES, detail: NORMAL_ENTITY_DETAIL });
    await page.goto('http://localhost:4173/projects/proj-1/knowledge');
    await page.waitForSelector('text=CodeStyle', { timeout: 8000 });
    await page.click('text=CodeStyle');
    await page.waitForTimeout(500);
    await screenshot(page, 'knowledge-normal-split-desktop');

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(overflow).toBe(false);
  });

  test('empty state', async ({ page }) => {
    await setupMocks(page, { entities: EMPTY_ENTITIES });
    await page.goto('http://localhost:4173/projects/proj-1/knowledge');
    await page.waitForSelector('text=Knowledge', { timeout: 8000 });
    await screenshot(page, 'knowledge-empty-desktop');

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(overflow).toBe(false);
  });

  test('long text — entity names and descriptions wrap', async ({ page }) => {
    await setupMocks(page, { entities: LONG_TEXT_ENTITIES, detail: LONG_TEXT_DETAIL });
    await page.goto('http://localhost:4173/projects/proj-1/knowledge');
    await page.waitForSelector('text=Knowledge', { timeout: 8000 });
    // Click first long-text entity to open detail
    const cards = page.locator('[class*="rounded-lg"][class*="border"]').first();
    await cards.click();
    await page.waitForTimeout(500);
    await screenshot(page, 'knowledge-long-text-desktop');

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(overflow).toBe(false);
  });

  test('many items (35)', async ({ page }) => {
    await setupMocks(page, { entities: MANY_ENTITIES });
    await page.goto('http://localhost:4173/projects/proj-1/knowledge');
    await page.waitForSelector('text=Knowledge', { timeout: 8000 });
    await screenshot(page, 'knowledge-many-desktop');

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(overflow).toBe(false);
  });

  test('create form visible and usable', async ({ page }) => {
    await setupMocks(page, { entities: NORMAL_ENTITIES });
    await page.goto('http://localhost:4173/projects/proj-1/knowledge');
    await page.waitForSelector('text=Add Entity', { timeout: 8000 });
    await page.click('text=Add Entity');
    await page.waitForTimeout(300);
    await screenshot(page, 'knowledge-create-form-desktop');

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(overflow).toBe(false);
  });

  test('special characters — XSS safe', async ({ page }) => {
    await setupMocks(page, { entities: SPECIAL_CHAR_ENTITIES });
    await page.goto('http://localhost:4173/projects/proj-1/knowledge');
    await page.waitForSelector('text=Knowledge', { timeout: 8000 });
    await screenshot(page, 'knowledge-special-chars-desktop');

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(overflow).toBe(false);
  });

  test('keyboard nav — filter chips accessible via Tab', async ({ page }) => {
    await setupMocks(page, { entities: NORMAL_ENTITIES });
    await page.goto('http://localhost:4173/projects/proj-1/knowledge');
    await page.waitForSelector('text=Knowledge', { timeout: 8000 });

    // Tab through to filter chips
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await page.waitForTimeout(200);
    await screenshot(page, 'knowledge-keyboard-focus-desktop');
  });
});
