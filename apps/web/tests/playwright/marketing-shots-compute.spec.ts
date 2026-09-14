/**
 * Marketing screenshots for the Compute / Infrastructure surfaces — renders the
 * REAL production components with mocked API data and captures the images
 * embedded in the public marketing site
 * (apps/www/src/data/features.ts → apps/www/public/images/features).
 *
 * Covered surfaces:
 *   A. Project compute pool editor (multi-provider offerings)      — sam-compute-pool-editor
 *      + catalog filters / "manage offerings" view                — sam-compute-offerings-manager
 *   B. Chat session placement decision                             — sam-compute-placement-decision
 *   C. Nodes page across providers                                 — sam-nodes-multi-provider
 *   D. Settings → Usage: AI usage + budget                         — sam-usage-tokens
 *   E. Settings → Usage: compute usage + quota                     — sam-usage-compute
 *   F. Admin → Costs                                                — sam-admin-costs
 *   G. Admin → Usage (nodes by user)                                — sam-admin-usage-nodes
 *
 * Run with the marketing output flag to write committed images:
 *   cd apps/web && MARKETING_SHOTS=1 PLAYWRIGHT_BASE_URL=http://localhost:4173 \
 *     npx playwright test tests/playwright/marketing-shots-compute.spec.ts --project="Desktop (1280x800)"
 *
 * Without MARKETING_SHOTS the images land in the gitignored tmp dir, so the
 * spec is safe to run as part of the normal visual-audit sweep.
 */
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { expect, type Page, type Route, test } from '@playwright/test';

import {
  assertNoOverflow,
  type AuditResponder,
  jsonResponse,
  setupAuditRoutes,
  setupProjectChatMocks,
} from './audit-helpers';
import {
  dismissOnboarding,
  MARKETING_THEME,
  MARKETING_USER,
  MARKETING_VIEWPORT,
  marketingShot,
  NORTHWIND,
} from './marketing-shots-helpers';

test.use(MARKETING_VIEWPORT);
test.setTimeout(60_000);

const TS = '2026-09-01T00:00:00.000Z';

// ---------------------------------------------------------------------------
// Shared marketing-shot helpers (local to this spec; do not touch the shared
// helper files).
// ---------------------------------------------------------------------------

const FEATURE_IMAGE_DIR = resolve(process.cwd(), '../www/public/images/features');
const TMP_SCREENSHOT_DIR = resolve(process.cwd(), '../../.codex/tmp/playwright-screenshots');

/**
 * Captures a vertical span of the page — from the top of `fromLocator` down to
 * the top of `toLocator` (or the bottom of the page when `toLocator` is
 * omitted) — as a single clipped screenshot. Used for sibling sections that
 * share no wrapping `<section>` element, so `screenshotSectionNearHeading`'s
 * ancestor search can't isolate them.
 */
/**
 * AppShell renders `<main class="... overflow-y-auto ...">` as the real
 * scroll container while `<html>`/`<body>` stay pinned to the viewport height
 * with `overflow: hidden`. That means `document.documentElement.scrollHeight`
 * (and Playwright's `fullPage`/`clip` capture, which resizes the OUTER page)
 * never reflects content taller than one viewport — relax the scroller's CSS
 * so the whole page lays out at its natural full height before measuring or
 * capturing. Read-only capture path; the page is not reused afterward.
 */
async function exposeFullPageHeight(page: Page) {
  await page.evaluate(() => {
    // Unconditionally relax every element whose computed overflow-y could be
    // clipping/scrolling height — a single querySelectorAll pass sees each
    // element's ORIGINAL computed style, so this must not be gated on
    // "currently taller than its box" (that's a chicken-and-egg check: an
    // ancestor's own scrollHeight only reflects an inner scroller's grown
    // height once the inner scroller has ALREADY been relaxed).
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('*'))) {
      const style = getComputedStyle(el);
      if (
        style.overflowY === 'auto' ||
        style.overflowY === 'scroll' ||
        style.overflowY === 'hidden' ||
        style.overflow === 'hidden'
      ) {
        el.style.setProperty('overflow', 'visible', 'important');
        el.style.setProperty('height', 'auto', 'important');
        el.style.setProperty('max-height', 'none', 'important');
        el.style.setProperty('min-height', '0', 'important');
      }
    }
    document.documentElement.style.setProperty('overflow', 'visible', 'important');
    document.documentElement.style.setProperty('height', 'auto', 'important');
    document.body.style.setProperty('overflow', 'visible', 'important');
    document.body.style.setProperty('height', 'auto', 'important');
  });
}

async function marketingSpanShot(
  page: Page,
  name: string,
  fromLocator: ReturnType<Page['locator']>,
  toLocator?: ReturnType<Page['locator']>
) {
  await exposeFullPageHeight(page);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(400);
  const fromBox = await fromLocator.boundingBox();
  if (!fromBox) throw new Error(`marketingSpanShot(${name}): "from" locator not measurable`);
  const pageWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  const pageHeight = await page.evaluate(() => document.documentElement.scrollHeight);
  // Clip to the main content column only — exclude the nav sidebar so the
  // capture reads as a standalone panel rather than a partial app chrome.
  const contentLeft = await page.evaluate(() => {
    const main = document.querySelector('main');
    return main ? main.getBoundingClientRect().x : 0;
  });
  const leftPad = 24;
  const padding = 16;
  // Small safety margin: CDP's full-page capture height can be a couple of
  // physical pixels shorter than the JS-computed scrollHeight, which makes an
  // unpadded bottom bound report "outside the resulting image".
  const safeBottom = Math.max(1, pageHeight - 4);
  const y = Math.max(0, Math.min(fromBox.y - padding, safeBottom - 1));
  let bottom = safeBottom;
  if (toLocator) {
    const toBox = await toLocator.boundingBox();
    if (toBox) bottom = Math.min(safeBottom, Math.max(y + 80, toBox.y - padding));
  }
  const x = Math.max(0, contentLeft - leftPad);
  const width = Math.max(1, pageWidth - x);
  const clip = { x, y, width, height: Math.max(1, bottom - y) };
  const dir = process.env.MARKETING_SHOTS ? FEATURE_IMAGE_DIR : TMP_SCREENSHOT_DIR;
  mkdirSync(dir, { recursive: true });
  await page.waitForTimeout(300);
  const fileName = `${name}${MARKETING_THEME === 'light' ? '-light' : ''}.png`;
  await page.screenshot({ path: `${dir}/${fileName}`, clip, fullPage: true });
}

/**
 * Scrolls the AppShell's internal `<main>` scroll container (not the window —
 * see `exposeFullPageHeight`'s doc comment) so `locator` sits `offset` CSS px
 * below the top of `<main>`. Used for viewport-bounded marketing captures
 * that must stay under a fixed pixel budget, as opposed to `marketingSpanShot`
 * / `exposeFullPageHeight`'s whole-section captures.
 */
async function scrollHeadingNearTop(
  page: Page,
  locator: ReturnType<Page['locator']>,
  offset = 24
) {
  // JS `main.scrollTop` assignment (and even native `scrollIntoViewIfNeeded`)
  // read `#main-content`'s `scrollHeight` as exactly equal to `clientHeight`
  // — i.e. "no overflow" — for several seconds after `page.setViewportSize`
  // on this page, even though its child content is genuinely thousands of
  // pixels taller. That is not a brief reflow race (a 5s poll never cleared
  // it); the measurement itself is unreliable here. Physical wheel events
  // drive the browser's real scroll pipeline instead of a JS-read scroll
  // metric, sidestepping the bad measurement entirely.
  const mainBox = await page.locator('main').first().boundingBox();
  if (mainBox) {
    await page.mouse.move(mainBox.x + mainBox.width / 2, mainBox.y + mainBox.height / 2);
  }
  // Capped step + a settle wait longer than Chromium's smooth-scroll wheel
  // animation: firing large deltas back-to-back measured a stale
  // mid-animation position and compounded into overshoot past the target.
  const maxStep = 500;
  for (let attempt = 0; attempt < 80; attempt++) {
    const box = await locator.boundingBox();
    if (!box) break;
    const delta = box.y - offset;
    if (Math.abs(delta) < 4) break;
    const step = Math.max(-maxStep, Math.min(maxStep, delta));
    await page.mouse.wheel(0, step);
    await page.waitForTimeout(180);
  }
  await page.waitForTimeout(400);
}

function attachDiagnostics(page: Page) {
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.log(`[console:error] ${msg.text()}`);
  });
  page.on('requestfailed', (req) => {
    console.log(`[requestfailed] ${req.method()} ${req.url()} — ${req.failure()?.errorText}`);
  });
}

// ---------------------------------------------------------------------------
// Shared Northwind world: project + chrome mocks common to every surface.
// ---------------------------------------------------------------------------

const PROJECT = {
  id: NORTHWIND.projectId,
  name: NORTHWIND.projectName,
  repository: NORTHWIND.repository,
  defaultBranch: NORTHWIND.defaultBranch,
  userId: NORTHWIND.owner.id,
  githubInstallationId: 'inst-northwind',
  defaultVmSize: null,
  defaultAgentType: null,
  defaultProvider: 'hetzner',
  defaultLocation: 'fsn1',
  workspaceIdleTimeoutMs: null,
  nodeIdleTimeoutMs: null,
  resourceRequirementsJson: JSON.stringify({ minVcpu: 2, minMemoryGb: 4, minDiskGb: 40 }),
  status: 'active',
  createdAt: TS,
  updatedAt: TS,
};

/**
 * Handles the app-chrome endpoints every authenticated page hits (nav, sidebar,
 * notifications, project switcher, etc). Returns `undefined` for anything it
 * doesn't recognize so the caller can layer page-specific routes before
 * falling back to this, and `setupAuditRoutes`'s own `{}` default beyond that.
 */
function commonChromeHandler(
  path: string,
  respond: AuditResponder,
  opts: { catalogs?: unknown[] } = {}
) {
  if (path.startsWith('/api/auth/')) return respond(200, MARKETING_USER);
  if (path === '/api/projects') return respond(200, { projects: [PROJECT], nextCursor: null });
  if (path === `/api/projects/${PROJECT.id}`) return respond(200, PROJECT);
  if (path.startsWith('/api/notifications')) {
    return respond(200, { notifications: [], unreadCount: 0 });
  }
  // Non-empty on all three reads: `useSetupStatus` (hooks/useSetupStatus.ts)
  // computes `isComplete = hasAgent && hasCloud && hasGitHub` from exactly
  // these three endpoints, and NavSidebar renders a glowing "Complete Setup"
  // CTA whenever onboarding is incomplete. Mock all three as satisfied so the
  // CTA does not render on any marketing capture.
  if (path === '/api/github/installations') {
    return respond(200, [
      {
        id: 'inst-northwind',
        userId: NORTHWIND.owner.id,
        installationId: 'inst-northwind',
        accountType: 'Organization',
        accountName: 'northwind-labs',
        createdAt: TS,
        updatedAt: TS,
      },
    ]);
  }
  if (path === '/api/credentials/agent') {
    return respond(200, {
      credentials: [
        {
          id: 'cred-claude-code',
          agentType: 'claude-code',
          credentialKind: 'api-key',
          maskedKey: 'sk-****nwnd',
          isActive: true,
          createdAt: TS,
          updatedAt: TS,
        },
      ],
    });
  }
  if (path === '/api/credentials') {
    return respond(200, [
      { provider: 'hetzner', status: 'valid', name: 'Payments API Hetzner token' },
    ]);
  }
  if (path === '/api/agents') return respond(200, { agents: [] });
  if (path === '/api/nodes') return respond(200, []);
  if (path === '/api/dashboard/active-tasks') return respond(200, { tasks: [] });
  if (path === '/api/chats' || path === '/api/chats/recent') {
    return respond(200, { sessions: [], total: 0, totalActive: 0 });
  }
  if (path === '/api/account-map') return respond(200, { nodes: [], edges: [] });
  if (path === '/api/trial-status' || path === '/api/trial/status') {
    return respond(200, { available: false });
  }
  if (path === '/api/providers/catalog') return respond(200, { catalogs: opts.catalogs ?? [] });
  if (path === '/api/report-issue/config') return respond(200, { enabled: false });
  return undefined;
}

// ---------------------------------------------------------------------------
// A. Project compute pool editor — multi-provider offerings
// ---------------------------------------------------------------------------

type Provider = 'hetzner' | 'scaleway' | 'vultr';

const PROVIDER_LOCATIONS: Record<Provider, Array<{ id: string; name: string; country: string }>> = {
  hetzner: [
    { id: 'fsn1', name: 'Falkenstein', country: 'DE' },
    { id: 'nbg1', name: 'Nuremberg', country: 'DE' },
    { id: 'hel1', name: 'Helsinki', country: 'FI' },
  ],
  scaleway: [
    { id: 'fr-par-2', name: 'Paris 2', country: 'FR' },
    { id: 'nl-ams-1', name: 'Amsterdam 1', country: 'NL' },
  ],
  vultr: [
    { id: 'ewr', name: 'New Jersey', country: 'US' },
    { id: 'fra', name: 'Frankfurt', country: 'DE' },
    { id: 'ord', name: 'Chicago', country: 'US' },
  ],
};

const CREDENTIAL_SOURCE_BY_PROVIDER: Record<
  Provider,
  {
    sourceId: string;
    credentialSource: 'project' | 'user';
    credentialId: string;
    ownerUserId: string | null;
    credentialReference: string;
  }
> = {
  hetzner: {
    sourceId: 'source-hetzner-project',
    credentialSource: 'project',
    credentialId: 'credential-project-hetzner',
    ownerUserId: null,
    credentialReference: 'credentials:project-hetzner-payments-api',
  },
  scaleway: {
    sourceId: 'source-scaleway-elena',
    credentialSource: 'user',
    credentialId: 'credential-user-elena-scaleway',
    ownerUserId: NORTHWIND.members[1].id, // Elena Rossi — granted to the project
    credentialReference: 'credentials:elena-rossi-scaleway-token (granted to Payments API)',
  },
  vultr: {
    sourceId: 'source-vultr-project',
    credentialSource: 'project',
    credentialId: 'credential-project-vultr',
    ownerUserId: null,
    credentialReference: 'credentials:project-vultr-payments-api',
  },
};

interface OfferingSpec {
  /** Present => this offering is also a pool candidate, not just a catalog row. */
  candidateId?: string;
  provider: Provider;
  location: string;
  sku: string;
  vcpu: number;
  ramGb: number;
  diskGb: number;
  priceCents: number;
  currency: 'EUR' | 'USD';
  disabled?: boolean;
  /** When set, the offering is unavailable (e.g. "Region sold out") in both the candidate and catalog rows. */
  unavailable?: string;
}

// `ComputePoolOfferingsManager`'s `sortOfferings` groups every list
// (Allowed instances AND the catalog-add list) by `providerLabel` first —
// alphabetically Hetzner < Scaleway < Vultr, unconditionally — then by
// location, then by price. That means an "Allowed" card's position is NOT
// controlled by insertion order; it is entirely a function of (a) which
// provider it belongs to and (b) how many OTHER active offerings share a
// provider that sorts earlier. To get a multi-provider story inside the
// first few cards, Hetzner's ACTIVE footprint must be minimal (else every
// Hetzner card sorts before any Scaleway/Vultr card, regardless of order).
// See the coordinator note in the PR description for the exact tradeoff.
// `ComputePoolOfferingsManager`'s "Allowed instances" list is ALSO capped —
// `max-h-[28rem] overflow-y-auto` (448px, its own internal scroll) — so only
// ~3 cards are visible in ANY viewport tall enough to reach it, independent
// of outer page scroll. Getting 3 distinct providers into that 3-card window
// requires exactly one active Hetzner card, exactly one active Scaleway
// card, and the FIRST (alphabetically-earliest-location, then
// cheapest-in-that-location) active Vultr card to be vc2-4c-8gb @ ewr — so
// vc2-2c-4gb @ ewr must NOT be active (it would outsort vc2-4c-8gb on price
// and take the 3rd-card slot instead).
const OFFERING_SPECS: OfferingSpec[] = [
  // Hetzner: only cx23 is active (card 1 of "Allowed"). cx43 and cx33 stay
  // real catalog rows (unavailable / not-selected) so the offerings-manager
  // catalog list still demonstrates every status within its first four
  // (Hetzner) cards.
  { candidateId: 'cand-hetzner-cx23-fsn1', provider: 'hetzner', location: 'fsn1', sku: 'cx23', vcpu: 2, ramGb: 4, diskGb: 40, priceCents: 549, currency: 'EUR' },
  { candidateId: 'cand-hetzner-cx43-fsn1', provider: 'hetzner', location: 'fsn1', sku: 'cx43', vcpu: 8, ramGb: 16, diskGb: 160, priceCents: 1599, currency: 'EUR', disabled: true, unavailable: 'Region sold out' },
  { candidateId: 'cand-hetzner-cx33-nbg1', provider: 'hetzner', location: 'nbg1', sku: 'cx33', vcpu: 4, ramGb: 8, diskGb: 80, priceCents: 849, currency: 'EUR', disabled: true },
  // Scaleway: only PLAY2-MICRO is active (card 2, via Elena's granted
  // credential). PRO2-S stays a real "Not selected" candidate row.
  { candidateId: 'cand-scaleway-play2micro-par2', provider: 'scaleway', location: 'fr-par-2', sku: 'PLAY2-MICRO', vcpu: 2, ramGb: 4, diskGb: 20, priceCents: 799, currency: 'EUR' },
  { candidateId: 'cand-scaleway-pro2s-ams1', provider: 'scaleway', location: 'nl-ams-1', sku: 'PRO2-S', vcpu: 2, ramGb: 8, diskGb: 50, priceCents: 1606, currency: 'EUR', disabled: true },
  // Vultr: 5 active across 3 locations (ewr/fra/ord) to keep total Allowed
  // at 7. Only vc2-4c-8gb is active at ewr, so it alone sorts as card 3.
  { candidateId: 'cand-vultr-vc24c8gb-ewr', provider: 'vultr', location: 'ewr', sku: 'vc2-4c-8gb', vcpu: 4, ramGb: 8, diskGb: 160, priceCents: 4800, currency: 'USD' },
  { candidateId: 'cand-vultr-vc22c4gb-fra', provider: 'vultr', location: 'fra', sku: 'vc2-2c-4gb', vcpu: 2, ramGb: 4, diskGb: 80, priceCents: 2400, currency: 'USD' },
  { candidateId: 'cand-vultr-vc24c8gb-fra', provider: 'vultr', location: 'fra', sku: 'vc2-4c-8gb', vcpu: 4, ramGb: 8, diskGb: 160, priceCents: 4800, currency: 'USD' },
  { candidateId: 'cand-vultr-vc22c4gb-ord', provider: 'vultr', location: 'ord', sku: 'vc2-2c-4gb', vcpu: 2, ramGb: 4, diskGb: 80, priceCents: 2400, currency: 'USD' },
  { candidateId: 'cand-vultr-vc24c8gb-ord', provider: 'vultr', location: 'ord', sku: 'vc2-4c-8gb', vcpu: 4, ramGb: 8, diskGb: 160, priceCents: 4800, currency: 'USD' },
  // Catalog-only additions — no candidateId, so they only appear in the edit
  // view's "Add instances from catalog" list, labeled "Catalog only". Both
  // sort into the first 4 catalog cards (Hetzner, then Scaleway groups).
  { provider: 'hetzner', location: 'hel1', sku: 'cpx31', vcpu: 4, ramGb: 8, diskGb: 160, priceCents: 1559, currency: 'EUR' },
  { provider: 'scaleway', location: 'fr-par-2', sku: 'PRO2-S', vcpu: 2, ramGb: 8, diskGb: 50, priceCents: 1606, currency: 'EUR' },
];

function priceDisplay(spec: OfferingSpec): string {
  const symbol = spec.currency === 'EUR' ? '€' : '$';
  return `${symbol}${(spec.priceCents / 100).toFixed(2)}/mo`;
}

function buildCandidate(spec: OfferingSpec, index: number) {
  const source = CREDENTIAL_SOURCE_BY_PROVIDER[spec.provider];
  return {
    id: spec.candidateId,
    poolId: 'project-default-pool',
    capacitySourceId: source.sourceId,
    provider: spec.provider,
    location: spec.location,
    workloadRole: 'workspace',
    runtime: 'vm',
    machineClass: 'shared-vm',
    machineSize: null,
    providerInstanceType: spec.sku,
    providerInstanceSku: null,
    providerInstanceDisplayName: `${spec.sku} · ${spec.vcpu} vCPU · ${spec.ramGb} GB RAM · ${spec.diskGb} GB disk`,
    providerInstanceVcpuCount: spec.vcpu,
    providerInstanceMemoryMb: spec.ramGb * 1024,
    providerInstanceDiskGb: spec.diskGb,
    providerInstancePriceDisplay: priceDisplay(spec),
    providerInstancePriceCurrency: spec.currency,
    providerInstancePriceMonthlyCents: spec.priceCents,
    providerInstancePriceHourlyMicros: Math.round((spec.priceCents * 10_000) / 730),
    providerInstanceCatalogSource: 'static',
    providerInstanceCatalogLastSeenAt: null,
    priority: index,
    candidateOrder: index,
    status: spec.disabled ? 'disabled' : 'active',
    createdAt: TS,
    updatedAt: TS,
  };
}

function buildCatalogOffering(spec: OfferingSpec) {
  return {
    provider: spec.provider,
    location: spec.location,
    providerInstanceType: spec.sku,
    providerInstanceSku: null,
    displayName: `${spec.sku} catalog row`,
    sku: spec.sku,
    vcpu: spec.vcpu,
    memoryMb: spec.ramGb * 1024,
    diskGb: spec.diskGb,
    price: priceDisplay(spec),
    priceMonthly: spec.priceCents / 100,
    currency: spec.currency,
    available: !spec.unavailable,
    stale: false,
    status: spec.unavailable ?? null,
    catalogSource: 'static',
    catalogLastSeenAt: null,
  };
}

const POOL_CANDIDATES = OFFERING_SPECS.filter((spec) => spec.candidateId).map((spec, index) =>
  buildCandidate(spec, index)
);
const POOL_ACTIVE_COUNT = POOL_CANDIDATES.filter((c) => c.status === 'active').length;

const POOL_SOURCES = (['hetzner', 'scaleway', 'vultr'] as Provider[]).map((provider) => {
  const source = CREDENTIAL_SOURCE_BY_PROVIDER[provider];
  return {
    id: source.sourceId,
    scope: 'project',
    ownerUserId: source.ownerUserId,
    ownerProjectId: PROJECT.id,
    sourceKind: 'cloud-provider-credential',
    provider,
    credentialSource: source.credentialSource,
    credentialId: source.credentialId,
    platformCredentialId: null,
    credentialReference: source.credentialReference,
    credentialVersion: 1,
    externalSourceRef: null,
    status: 'active',
    createdAt: TS,
    updatedAt: TS,
  };
});

const CATALOGS = (['hetzner', 'scaleway', 'vultr'] as Provider[]).map((provider) => {
  const source = CREDENTIAL_SOURCE_BY_PROVIDER[provider];
  const offerings = OFFERING_SPECS.filter((spec) => spec.provider === provider).map(
    buildCatalogOffering
  );
  const locations = PROVIDER_LOCATIONS[provider];
  return {
    provider,
    credentialSource: source.credentialSource,
    credentialId: source.credentialId,
    platformCredentialId: null,
    externalSourceRef: null,
    credentialReference: null,
    locations,
    sizes: {},
    offerings,
    defaultLocation: locations[0]!.id,
  };
});

const POOL = {
  id: 'project-default-pool',
  scope: 'project',
  ownerUserId: null,
  ownerProjectId: PROJECT.id,
  name: 'Payments API project compute pool',
  isDefault: true,
  revision: 4,
  status: 'active',
  strategy: 'pack',
  exhaustionPolicy: 'fallback-chain',
  createdAt: TS,
  updatedAt: TS,
};

const EFFECTIVE_POOL_SUMMARY = {
  pool: POOL,
  sources: POOL_SOURCES,
  candidates: POOL_CANDIDATES,
  activeCandidateCount: POOL_ACTIVE_COUNT,
};

const SAFE_EFFECTIVE_SUMMARY = {
  scope: 'project',
  state: 'configured-ready',
  strategy: 'pack',
  exhaustionPolicy: 'fallback-chain',
  availableCandidateCount: POOL_ACTIVE_COUNT,
};

const CAPACITY_POOL_DEFAULTS_RESPONSE = {
  effective: EFFECTIVE_POOL_SUMMARY,
  effectiveScope: 'project',
  effectiveState: 'configured-ready',
  effectiveSummary: SAFE_EFFECTIVE_SUMMARY,
  defaults: [
    {
      scope: 'project',
      visibility: 'visible',
      visibilityReason: 'project-secret-read',
      canReconcile: true,
      summary: EFFECTIVE_POOL_SUMMARY,
    },
    {
      scope: 'user',
      visibility: 'visible',
      visibilityReason: 'authenticated-user',
      canReconcile: true,
      summary: null,
    },
    {
      scope: 'installation',
      visibility: 'hidden',
      visibilityReason: 'superadmin-required',
      canReconcile: false,
      summary: null,
    },
  ],
  precedence: ['project', 'user', 'installation'],
  reconciledScopes: ['project'],
  policyMutationSupported: true,
};

test.describe('A. Compute pool editor', () => {
  test('project compute pool shows multi-provider offerings, allowed/excluded/unavailable/catalog-only states', async ({
    page,
  }) => {
    attachDiagnostics(page);
    await dismissOnboarding(page);
    await setupAuditRoutes(page, (path, respond) => {
      if (path === `/api/projects/${PROJECT.id}/capacity-pools/defaults`) {
        return respond(200, CAPACITY_POOL_DEFAULTS_RESPONSE);
      }
      if (path === `/api/projects/${PROJECT.id}/members`) return respond(200, { members: [] });
      if (path === `/api/projects/${PROJECT.id}/runtime-config`) {
        return respond(200, { envVars: [], files: [] });
      }
      return commonChromeHandler(path, respond, { catalogs: CATALOGS });
    });

    await page.goto(`/projects/${PROJECT.id}/settings/infrastructure`);
    const heading = page.getByRole('heading', { name: 'Project Infrastructure Compute Pool' });
    await expect(heading).toBeVisible({ timeout: 20_000 });
    const excludedCount = POOL_CANDIDATES.length - POOL_ACTIVE_COUNT;
    await expect(
      page.getByText(`${POOL_ACTIVE_COUNT} allowed · ${excludedCount} not selected/removed`)
    ).toBeVisible();

    const section = heading.locator('xpath=ancestor::section[1]').first();
    await section.getByRole('button', { name: 'Edit' }).click();
    await expect(page.getByRole('heading', { name: 'Edit project default' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Catalog filters' })).toBeVisible();
    await expect(page.getByText('Catalog only').first()).toBeVisible();
    await expect(page.getByText('Not selected').first()).toBeVisible();
    await expect(page.getByText('Region sold out').first()).toBeVisible();
    await assertNoOverflow(page);

    // sam-compute-pool-editor: a viewport-bounded shot (not the whole,
    // 8000px-tall edit section) — resize taller than the shared marketing
    // viewport so the pool summary header, Strategy/Exhaustion selects, and
    // several Allowed cards all land above the fold, then scroll the heading
    // to just below the top of the AppShell's internal scroller.
    await page.setViewportSize({ width: 1440, height: 1100 });
    await page.waitForTimeout(300);
    await scrollHeadingNearTop(page, heading, 24);
    await expect(page.getByText(`${POOL_ACTIVE_COUNT} allowed · ${excludedCount} not selected/removed`)).toBeVisible();
    await marketingShot(page, 'sam-compute-pool-editor');

    // sam-compute-offerings-manager: same idea, scrolled to the catalog
    // filters + "Add instances from catalog" panel instead.
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.waitForTimeout(300);
    const catalogHeading = page.getByRole('heading', { name: 'Catalog filters' });
    await scrollHeadingNearTop(page, catalogHeading, 24);
    await expect(page.getByRole('heading', { name: 'Add instances from catalog' })).toBeVisible();
    await marketingShot(page, 'sam-compute-offerings-manager');
  });
});

// ---------------------------------------------------------------------------
// B. Chat session placement decision
// ---------------------------------------------------------------------------

const CHAT_SESSION_ID = 'chat-ledger-migration';
const CHAT_WORKSPACE_ID = 'ws-ledger-migration';
const CHAT_TASK_ID = 'task-ledger-migration';
const CHAT_NODE_ID = 'node-hetzner-cx33-fsn1-07';

const PLACEMENT_JSON = JSON.stringify({
  diagnostics: {
    version: 1,
    requested: { cpuMillis: 4000, memoryMb: 8192, diskMb: 81_920, evidence: 'requested' },
    selectedNodeId: CHAT_NODE_ID,
    authority: {
      capacityPoolScope: 'project',
      effectivePoolState: 'configured-ready',
      strategy: 'pack',
      strategyOrdering: 'highest projected utilization that still fits',
      revalidatedAgainstCurrentAuthority: true,
    },
    hosts: [
      {
        nodeId: CHAT_NODE_ID,
        outcome: 'selected',
        reasons: [
          'Reused warm Hetzner cx33 · fsn1 node (warm 11 min)',
          '1 co-tenant workspace already running on this node',
          'Highest projected utilization that still fits the request',
        ],
      },
    ],
    queue: { state: null, nextRetryAt: null, reason: null },
  },
});

const RESOLVED_RESERVATION_JSON = JSON.stringify({
  cpuMillis: 4000,
  memoryMb: 8192,
  diskMb: 81_920,
  exclusiveNode: false,
  maxCoTenants: 3,
  source: 'project',
  sourceId: 'PRIVATE-IDENTITY',
  credentialId: 'SECRET-MUST-NOT-RENDER',
});

const CHAT_WORKSPACE = {
  id: CHAT_WORKSPACE_ID,
  nodeId: CHAT_NODE_ID,
  name: 'ws-ledger-migration',
  displayName: 'Ledger migration workspace',
  status: 'running',
  projectId: PROJECT.id,
  repository: NORTHWIND.repository,
  branch: 'sam/migrate-ledger-double-entry',
  vmSize: 'medium',
  vmLocation: 'fsn1',
  vmIp: '10.20.30.40',
  url: `https://ws-${CHAT_WORKSPACE_ID}.sammy.party`,
  lastActivityAt: '2026-09-08T15:42:00Z',
  errorMessage: null,
  createdAt: '2026-09-08T15:10:00Z',
  updatedAt: '2026-09-08T15:42:00Z',
  workspaceProfile: 'full',
  placementExplanationJson: PLACEMENT_JSON,
  resolvedReservationJson: RESOLVED_RESERVATION_JSON,
  resourceRequirementsJson: JSON.stringify({ minVcpu: 4, minMemoryGb: 8, minDiskGb: 80 }),
};

const CHAT_NODE = {
  id: CHAT_NODE_ID,
  name: 'node-hetzner-cx33-fsn1-07',
  status: 'running',
  healthStatus: 'healthy',
  cloudProvider: 'hetzner',
  vmSize: 'medium',
  vmLocation: 'fsn1',
  nodeRole: 'workspace',
  ipAddress: '10.20.30.40',
  lastHeartbeatAt: '2026-09-08T15:50:00Z',
  providerInstanceType: 'cx33',
  providerInstanceVcpuCount: 4,
  providerInstanceMemoryMb: 8192,
  providerInstanceDiskGb: 80,
  observedProviderInstanceType: 'cx33',
  observedProviderInstanceVcpuCount: 4,
  observedProviderInstanceMemoryMb: 8192,
  observedProviderInstanceDiskGb: 80,
  providerInstancePriceDisplay: '€8.49/mo',
  errorMessage: null,
  createdAt: '2026-09-07T09:00:00Z',
  updatedAt: '2026-09-08T15:50:00Z',
};

const CHAT_SESSION = {
  id: CHAT_SESSION_ID,
  workspaceId: CHAT_WORKSPACE_ID,
  taskId: CHAT_TASK_ID,
  topic: 'Migrate ledger to double-entry schema',
  status: 'active',
  messageCount: 4,
  startedAt: Date.parse('2026-09-08T15:10:00Z'),
  endedAt: null,
  createdAt: Date.parse('2026-09-08T15:10:00Z'),
  lastMessageAt: Date.parse('2026-09-08T15:44:00Z'),
  isIdle: false,
  isTerminated: false,
  isMine: true,
  agentSessionId: 'acp-ledger-migration',
  agentType: 'claude-code',
  task: {
    id: CHAT_TASK_ID,
    placementExplanationJson: PLACEMENT_JSON,
    status: 'in_progress',
    executionStep: 'agent_session',
    errorMessage: null,
    outputBranch: 'sam/migrate-ledger-double-entry',
    outputPrUrl: null,
    outputSummary: null,
    finalizedAt: null,
    taskMode: 'task',
    agentProfileHint: 'Claude Code — Opus 5',
  },
};

const CHAT_MESSAGES = [
  {
    id: 'msg-1',
    sessionId: CHAT_SESSION_ID,
    role: 'user',
    content:
      'Migrate the ledger tables to a proper double-entry schema — every transaction should post two balanced rows.',
    toolMetadata: null,
    createdAt: Date.parse('2026-09-08T15:10:30Z'),
    sequence: 1,
  },
  {
    id: 'msg-2',
    sessionId: CHAT_SESSION_ID,
    role: 'assistant',
    content:
      "Reviewing the current `ledger_entries` table. I'll add `ledger_postings` with a debit/credit pair per transaction and a trigger that enforces the balance.",
    toolMetadata: null,
    createdAt: Date.parse('2026-09-08T15:12:00Z'),
    sequence: 2,
  },
  {
    id: 'msg-3',
    sessionId: CHAT_SESSION_ID,
    role: 'user',
    content: 'Sounds good — keep the migration backward compatible with the reporting views.',
    toolMetadata: null,
    createdAt: Date.parse('2026-09-08T15:15:00Z'),
    sequence: 3,
  },
  {
    id: 'msg-4',
    sessionId: CHAT_SESSION_ID,
    role: 'assistant',
    content:
      'Added the compatibility view `ledger_entries_v1` backed by `ledger_postings`. Running the migration against the staging snapshot now.',
    toolMetadata: null,
    createdAt: Date.parse('2026-09-08T15:44:00Z'),
    sequence: 4,
  },
];

// `getProjectTask` result for the session's linked task. `useProjectChatState`
// fetches this on mount to decide whether to show the provisioning banner —
// any status other than 'in_progress' or terminal makes it think the
// workspace is still being created, covering the conversation with a
// "Starting…" overlay. Must match `CHAT_SESSION.task` above.
const CHAT_TASK_DETAIL = {
  id: CHAT_TASK_ID,
  projectId: PROJECT.id,
  title: 'Migrate ledger to double-entry schema',
  status: 'in_progress',
  executionStep: 'agent_session',
  errorMessage: null,
  outputBranch: 'sam/migrate-ledger-double-entry',
  outputPrUrl: null,
  outputSummary: null,
  finalizedAt: null,
  taskMode: 'task',
  agentProfileHint: 'Claude Code — Opus 5',
  priority: 0,
  parentTaskId: null,
  workspaceId: CHAT_WORKSPACE_ID,
  requestedVmSize: null,
  provisionedVmSize: null,
  startedAt: '2026-09-08T15:10:00Z',
  createdAt: '2026-09-08T15:09:00Z',
  updatedAt: '2026-09-08T15:44:00Z',
  dependencies: [],
  blocked: false,
};

// Session state snapshot (catch-up shape) — without it the header falls back
// to a loading/unknown activity state instead of showing "Agent running".
const CHAT_SESSION_STATE = {
  activity: 'prompting',
  activityAt: Date.parse('2026-09-08T15:44:00Z'),
  statusError: null,
  currentPlan: [],
  planUpdatedAt: null,
  promptStartedAt: Date.parse('2026-09-08T15:44:00Z'),
  agentType: 'claude-code',
  lastStopReason: null,
};

test.describe('B. Chat placement decision', () => {
  test('session header shows the resolved compute pool, resources, and placement decision', async ({
    page,
  }) => {
    attachDiagnostics(page);
    // Freeze "now" shortly after the session's last activity so the header's
    // Date.now()-based elapsed-time text ("Xm (running)") stays a small,
    // deterministic value instead of drifting with the real clock.
    await page.clock.install({ time: new Date('2026-09-08T16:04:00Z') });
    // Broad chrome catch-all first (lowest precedence).
    await setupAuditRoutes(page, (path, respond) =>
      commonChromeHandler(path, respond, { catalogs: CATALOGS })
    );
    // Project-chat-specific mocks (auth/session/messages/etc) — registered
    // after the catch-all, so they take precedence for their exact routes.
    await setupProjectChatMocks(page, {
      projectId: PROJECT.id,
      project: PROJECT,
      session: CHAT_SESSION,
      messages: CHAT_MESSAGES,
      user: MARKETING_USER.user,
    });
    // Most specific: this test's own infrastructure data, registered last.
    await page.route(
      new RegExp(`/api/projects/${PROJECT.id}/sessions/${CHAT_SESSION_ID}(?:\\?.*)?$`),
      (route: Route) =>
        jsonResponse(route, 200, {
          session: CHAT_SESSION,
          messages: CHAT_MESSAGES,
          hasMore: false,
          state: CHAT_SESSION_STATE,
        })
    );
    await page.route(`**/api/projects/${PROJECT.id}/tasks/${CHAT_TASK_ID}`, (route: Route) =>
      jsonResponse(route, 200, CHAT_TASK_DETAIL)
    );
    await page.route(`**/api/workspaces/${CHAT_WORKSPACE_ID}`, (route: Route) =>
      jsonResponse(route, 200, CHAT_WORKSPACE)
    );
    await page.route(`**/api/workspaces/${CHAT_WORKSPACE_ID}/ports*`, (route: Route) =>
      jsonResponse(route, 200, { ports: [] })
    );
    await page.route(`**/api/nodes/${CHAT_NODE_ID}`, (route: Route) =>
      jsonResponse(route, 200, CHAT_NODE)
    );
    await page.route(`**/api/projects/${PROJECT.id}/capacity-pools/defaults*`, (route: Route) =>
      jsonResponse(route, 200, CAPACITY_POOL_DEFAULTS_RESPONSE)
    );

    await page.goto(`/projects/${PROJECT.id}/chat/${CHAT_SESSION_ID}`);
    await expect(page.getByRole('log', { name: 'Conversation' })).toBeVisible({ timeout: 20_000 });
    // Liveness: a real conversation message rendered in the log, not just an
    // occluded DOM node behind a loading overlay (rule 62/rule-56 class bug).
    await expect(
      page.getByRole('log', { name: 'Conversation' }).getByText('Reviewing the current')
    ).toBeVisible();
    await expect(page.getByText('Starting…')).toHaveCount(0);
    await expect(page.getByText('Reconnecting…')).toHaveCount(0);

    await page.getByTestId('session-tool-details').click();
    await expect(page.getByText('Saved placement decision').first()).toBeVisible();
    await expect(page.getByText('Current compute pool')).toBeVisible();
    await expect(page.getByText(/Why this node/)).toBeVisible();
    await expect(page.getByText(/Reused warm Hetzner cx33/)).toBeVisible();
    await assertNoOverflow(page);

    // Cosmetic only: the mocked environment has no real WebSocket server, so
    // the WS handshake always fails and the connection banner would
    // permanently read "Reconnecting…" — hide it for the marketing capture.
    const reconnectBanner = page.getByRole('alert').filter({ hasText: 'Reconnecting' });
    if ((await reconnectBanner.count()) > 0) {
      await reconnectBanner.evaluate((el) => {
        (el as HTMLElement).style.display = 'none';
      });
    }

    await marketingShot(page, 'sam-compute-placement-decision');
  });
});

// ---------------------------------------------------------------------------
// C. Nodes — multi-provider fleet
// ---------------------------------------------------------------------------

function makeNode<T extends { id: string; name: string }>(overrides: T) {
  return {
    status: 'running',
    healthStatus: 'healthy',
    nodeRole: 'workspace',
    ipAddress: null as string | null,
    lastHeartbeatAt: null as string | null,
    lastMetrics: null as { cpuLoadAvg1: number; memoryPercent: number; diskPercent: number } | null,
    errorMessage: null as string | null,
    createdAt: '2026-09-05T08:00:00Z',
    updatedAt: '2026-09-08T16:00:00Z',
    ...overrides,
  };
}

const NODE_HETZNER_CX33 = makeNode({
  id: 'node-hetzner-cx33-fsn1-01',
  name: 'node-hetzner-cx33-fsn1-01',
  cloudProvider: 'hetzner',
  vmSize: 'medium',
  vmLocation: 'fsn1',
  ipAddress: '10.1.1.10',
  lastHeartbeatAt: '2026-09-08T16:00:00Z',
  providerInstanceType: 'cx33',
  providerInstanceVcpuCount: 4,
  providerInstanceMemoryMb: 8192,
  providerInstanceDiskGb: 80,
  observedProviderInstanceType: 'cx33',
  observedProviderInstanceVcpuCount: 4,
  observedProviderInstanceMemoryMb: 8192,
  observedProviderInstanceDiskGb: 80,
  providerInstancePriceDisplay: '€8.49/mo',
  lastMetrics: { cpuLoadAvg1: 41, memoryPercent: 58, diskPercent: 22 },
});

const NODE_HETZNER_CX43 = makeNode({
  id: 'node-hetzner-cx43-nbg1-02',
  name: 'node-hetzner-cx43-nbg1-02',
  cloudProvider: 'hetzner',
  vmSize: 'large',
  vmLocation: 'nbg1',
  ipAddress: '10.1.1.20',
  lastHeartbeatAt: '2026-09-08T16:00:00Z',
  createdAt: '2026-09-04T08:00:00Z',
  providerInstanceType: 'cx43',
  providerInstanceVcpuCount: 8,
  providerInstanceMemoryMb: 16_384,
  providerInstanceDiskGb: 160,
  observedProviderInstanceType: 'cx43',
  observedProviderInstanceVcpuCount: 8,
  observedProviderInstanceMemoryMb: 16_384,
  observedProviderInstanceDiskGb: 160,
  providerInstancePriceDisplay: '€15.99/mo',
  lastMetrics: { cpuLoadAvg1: 63, memoryPercent: 71, diskPercent: 35 },
});

const NODE_SCALEWAY_PRO2S = makeNode({
  id: 'node-scaleway-pro2s-par2-03',
  name: 'node-scaleway-pro2s-par2-03',
  cloudProvider: 'scaleway',
  vmSize: 'medium',
  vmLocation: 'fr-par-2',
  ipAddress: '10.1.2.10',
  lastHeartbeatAt: '2026-09-08T16:00:00Z',
  createdAt: '2026-09-08T14:30:00Z',
  providerInstanceType: 'PRO2-S',
  providerInstanceVcpuCount: 2,
  providerInstanceMemoryMb: 8192,
  providerInstanceDiskGb: 50,
  observedProviderInstanceType: 'PRO2-S',
  observedProviderInstanceVcpuCount: 2,
  observedProviderInstanceMemoryMb: 8192,
  observedProviderInstanceDiskGb: 50,
  providerInstancePriceDisplay: '€16.06/mo',
  lastMetrics: { cpuLoadAvg1: 3, memoryPercent: 9, diskPercent: 12 },
});

const NODE_VULTR_PROVISIONING = makeNode({
  id: 'node-vultr-vc24c8gb-ewr-04',
  name: 'node-vultr-vc24c8gb-ewr-04',
  status: 'creating',
  healthStatus: 'stale',
  cloudProvider: 'vultr',
  vmSize: 'large',
  vmLocation: 'ewr',
  createdAt: '2026-09-08T15:58:00Z',
  updatedAt: '2026-09-08T15:58:00Z',
  providerInstanceType: 'vc2-4c-8gb',
  providerInstanceVcpuCount: 4,
  providerInstanceMemoryMb: 8192,
  providerInstanceDiskGb: 160,
  providerInstancePriceDisplay: '$48.00/mo',
});

const NODES = [NODE_HETZNER_CX33, NODE_HETZNER_CX43, NODE_SCALEWAY_PRO2S, NODE_VULTR_PROVISIONING];

function makeWorkspace(
  id: string,
  nodeId: string,
  branch: string,
  displayName: string,
  vmLocation: string
) {
  return {
    id,
    nodeId,
    name: id,
    displayName,
    status: 'running',
    projectId: PROJECT.id,
    repository: NORTHWIND.repository,
    branch,
    vmSize: 'medium',
    vmLocation,
    vmIp: '10.1.1.10',
    lastActivityAt: '2026-09-08T15:55:00Z',
    errorMessage: null,
    createdAt: '2026-09-08T09:00:00Z',
    updatedAt: '2026-09-08T15:55:00Z',
  };
}

const WORKSPACES = [
  makeWorkspace(
    'ws-refund-webhook',
    NODE_HETZNER_CX33.id,
    'sam/idempotency-keys-refund-webhook',
    'Refund webhook idempotency',
    'fsn1'
  ),
  makeWorkspace(
    'ws-ledger-migration-fleet',
    NODE_HETZNER_CX33.id,
    'sam/migrate-ledger-double-entry',
    'Ledger migration',
    'fsn1'
  ),
  makeWorkspace(
    'ws-payout-retry',
    NODE_HETZNER_CX43.id,
    'sam/payout-retry-backoff',
    'Payout retry backoff',
    'nbg1'
  ),
  makeWorkspace(
    'ws-fraud-rules',
    NODE_HETZNER_CX43.id,
    'sam/fraud-rules-v2',
    'Fraud rules v2',
    'nbg1'
  ),
  makeWorkspace(
    'ws-webhook-signing',
    NODE_HETZNER_CX43.id,
    'sam/webhook-signing-rotation',
    'Webhook signing rotation',
    'nbg1'
  ),
];

test.describe('C. Nodes — multi-provider fleet', () => {
  test('nodes page shows hardware, metrics, and workspaces across providers', async ({ page }) => {
    attachDiagnostics(page);
    await dismissOnboarding(page);
    await setupAuditRoutes(page, (path, respond) => {
      if (path === '/api/nodes') return respond(200, NODES);
      if (path === '/api/workspaces') return respond(200, WORKSPACES);
      if (path === '/api/capacity-pools/defaults') {
        return respond(200, CAPACITY_POOL_DEFAULTS_RESPONSE);
      }
      return commonChromeHandler(path, respond, { catalogs: CATALOGS });
    });

    await page.goto('/nodes');
    await expect(page.getByRole('heading', { name: 'Nodes' })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(NODE_HETZNER_CX33.name)).toBeVisible();
    await expect(page.getByText(NODE_VULTR_PROVISIONING.name)).toBeVisible();
    await expect(page.getByText('sam/idempotency-keys-refund-webhook')).toBeVisible();
    await assertNoOverflow(page);

    await marketingShot(page, 'sam-nodes-multi-provider');
  });
});

// ---------------------------------------------------------------------------
// D + E. Settings → Usage (AI usage + budget, compute usage + quota)
// ---------------------------------------------------------------------------

const AI_BY_DAY = (
  [
    ['2026-09-01', 8.1, 210],
    ['2026-09-02', 9.85, 240],
    ['2026-09-03', 11.2, 265],
    ['2026-09-04', 7.4, 190],
    ['2026-09-05', 12.65, 310],
    ['2026-09-06', 6.05, 150],
    ['2026-09-07', 5.2, 130],
    ['2026-09-08', 14.9, 360],
    ['2026-09-09', 16.35, 395],
    ['2026-09-10', 13.7, 330],
    ['2026-09-11', 15.05, 350],
    ['2026-09-12', 17.8, 410],
    ['2026-09-13', 18.6, 430],
    ['2026-09-14', 16.35, 380],
  ] as const
).map(([date, costUsd, requests]) => ({
  date,
  requests,
  inputTokens: requests * 2000,
  outputTokens: requests * 320,
  costUsd,
}));

const AI_USAGE_RESPONSE = {
  totalCostUsd: 184.2,
  totalRequests: 5540,
  totalInputTokens: 11_100_000,
  totalOutputTokens: 1_755_000,
  cachedRequests: 990,
  errorRequests: 9,
  byModel: [
    { model: 'claude-opus-5', provider: 'anthropic', requests: 1240, inputTokens: 3_200_000, outputTokens: 540_000, costUsd: 98.4, cachedRequests: 220, errorRequests: 3 },
    { model: 'claude-sonnet-5', provider: 'anthropic', requests: 3100, inputTokens: 5_800_000, outputTokens: 910_000, costUsd: 52.1, cachedRequests: 640, errorRequests: 5 },
    { model: 'gpt-5.5', provider: 'openai', requests: 860, inputTokens: 1_500_000, outputTokens: 210_000, costUsd: 24.75, cachedRequests: 90, errorRequests: 1 },
    { model: 'gemini-2.5-pro', provider: 'google', requests: 340, inputTokens: 600_000, outputTokens: 95_000, costUsd: 8.95, cachedRequests: 40, errorRequests: 0 },
  ],
  byDay: AI_BY_DAY,
  period: 'current-month',
  periodLabel: 'September 2026',
};

const AI_BUDGET_RESPONSE = {
  settings: {
    dailyInputTokenLimit: 900_000,
    dailyOutputTokenLimit: 150_000,
    monthlyCostCapUsd: 400,
    alertThresholdPercent: 80,
  },
  isCustom: true,
  dailyUsage: { inputTokens: 610_000, outputTokens: 98_000 },
  effectiveLimits: { dailyInputTokenLimit: 900_000, dailyOutputTokenLimit: 150_000 },
  monthCostUsd: 184.2,
  utilization: { dailyInputPercent: 67.8, dailyOutputPercent: 65.3, monthlyCostPercent: 46.05 },
  exceeded: false,
};

const USAGE_PERIOD = { start: '2026-09-01T00:00:00Z', end: '2026-09-30T23:59:59Z' };

const COMPUTE_ACTIVE_NODES = [
  {
    nodeId: NODE_HETZNER_CX33.id,
    name: NODE_HETZNER_CX33.name,
    workspaceId: NODE_HETZNER_CX33.id,
    serverType: 'cx33',
    vmSize: 'medium',
    vcpuCount: 4,
    providerInstanceType: 'cx33',
    providerInstanceVcpuCount: 4,
    providerInstanceMemoryMb: 8192,
    providerInstanceDiskGb: 80,
    observedProviderInstanceType: 'cx33',
    observedProviderInstanceVcpuCount: 4,
    observedProviderInstanceMemoryMb: 8192,
    observedProviderInstanceDiskGb: 80,
    providerInstancePriceDisplay: '€8.49/mo',
    credentialSource: 'platform',
    startedAt: '2026-09-05T08:00:00Z',
    createdAt: '2026-09-05T08:00:00Z',
    status: 'running',
  },
  {
    nodeId: NODE_HETZNER_CX43.id,
    name: NODE_HETZNER_CX43.name,
    workspaceId: NODE_HETZNER_CX43.id,
    serverType: 'cx43',
    vmSize: 'large',
    vcpuCount: 8,
    providerInstanceType: 'cx43',
    providerInstanceVcpuCount: 8,
    providerInstanceMemoryMb: 16_384,
    providerInstanceDiskGb: 160,
    observedProviderInstanceType: 'cx43',
    observedProviderInstanceVcpuCount: 8,
    observedProviderInstanceMemoryMb: 16_384,
    observedProviderInstanceDiskGb: 160,
    providerInstancePriceDisplay: '€15.99/mo',
    credentialSource: 'platform',
    startedAt: '2026-09-04T08:00:00Z',
    createdAt: '2026-09-04T08:00:00Z',
    status: 'running',
  },
];

const COMPUTE_USAGE_RESPONSE = {
  currentPeriod: {
    totalNodeHours: 312.4,
    totalVcpuHours: 1187.2,
    platformNodeHours: 260.0,
    platformVcpuHours: 980.5,
    userNodeHours: 52.4,
    userVcpuHours: 206.7,
    activeNodes: COMPUTE_ACTIVE_NODES.length,
    activeWorkspaces: COMPUTE_ACTIVE_NODES.length,
    start: USAGE_PERIOD.start,
    end: USAGE_PERIOD.end,
  },
  activeSessions: COMPUTE_ACTIVE_NODES,
};

const QUOTA_RESPONSE = {
  byocExempt: false,
  monthlyVcpuHoursLimit: 600,
  currentUsage: 312.4,
  remaining: 287.6,
  periodStart: USAGE_PERIOD.start,
  periodEnd: USAGE_PERIOD.end,
};

test.describe('D+E. Settings usage', () => {
  test('AI usage + budget section, and compute usage + quota section', async ({ page }) => {
    attachDiagnostics(page);
    await dismissOnboarding(page);
    await setupAuditRoutes(page, (path, respond) => {
      if (path === '/api/usage/ai') return respond(200, AI_USAGE_RESPONSE);
      if (path === '/api/usage/ai/budget') return respond(200, AI_BUDGET_RESPONSE);
      if (path === '/api/usage/compute') return respond(200, COMPUTE_USAGE_RESPONSE);
      if (path === '/api/usage/quota') return respond(200, QUOTA_RESPONSE);
      return commonChromeHandler(path, respond, {});
    });

    await page.goto('/settings/usage');
    const llmHeading = page.getByRole('heading', { name: 'LLM Usage' });
    const computeHeading = page.getByRole('heading', { name: 'Compute Usage' });
    await expect(llmHeading).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText('claude-opus-5')).toBeVisible();
    await expect(computeHeading).toBeVisible();
    await expect(page.getByText('312.40 / 600 vCPU-hrs')).toBeVisible();
    await assertNoOverflow(page);

    // D: AI usage + budget — span from the LLM Usage heading down to (not
    // including) the Compute Usage heading, so both sibling sections land in
    // one image without a shared <section> ancestor to key off.
    await marketingSpanShot(page, 'sam-usage-tokens', llmHeading, computeHeading);

    // E: Compute usage + quota — from its heading down to the bottom of the
    // page (it's the last section on this route).
    await marketingSpanShot(page, 'sam-usage-compute', computeHeading);
  });
});

// ---------------------------------------------------------------------------
// F. Admin → Costs
// ---------------------------------------------------------------------------

const COST_BY_DAY = (
  [
    ['2026-09-01', 108.4],
    ['2026-09-02', 122.15],
    ['2026-09-03', 134.9],
    ['2026-09-04', 96.2],
    ['2026-09-05', 151.75],
    ['2026-09-06', 88.05],
    ['2026-09-07', 79.4],
    ['2026-09-08', 178.9],
    ['2026-09-09', 196.35],
    ['2026-09-10', 164.7],
    ['2026-09-11', 180.05],
    ['2026-09-12', 213.8],
    ['2026-09-13', 224.6],
    ['2026-09-14', 196.35],
  ] as const
).map(([date, costUsd]) => ({ date, requests: Math.round(costUsd * 24), costUsd }));

const COST_SUMMARY = {
  llm: {
    totalCostUsd: 2216.0,
    totalRequests: 82_000,
    totalInputTokens: 140_600_000,
    totalOutputTokens: 22_950_000,
    trialCostUsd: 0,
    cachedRequests: 9400,
    errorRequests: 62,
    byModel: [
      { model: 'claude-opus-5', provider: 'anthropic', requests: 18_400, inputTokens: 42_000_000, outputTokens: 7_100_000, costUsd: 1180.4 },
      { model: 'claude-sonnet-5', provider: 'anthropic', requests: 46_200, inputTokens: 71_000_000, outputTokens: 11_800_000, costUsd: 640.15 },
      { model: 'gpt-5.5', provider: 'openai', requests: 12_100, inputTokens: 19_500_000, outputTokens: 2_900_000, costUsd: 298.6 },
      { model: 'gemini-2.5-pro', provider: 'google', requests: 5300, inputTokens: 8_100_000, outputTokens: 1_150_000, costUsd: 96.85 },
    ],
    byDay: COST_BY_DAY,
    byUser: [
      { userId: 'user-priya', requests: 21_000, inputTokens: 38_000_000, outputTokens: 6_200_000, costUsd: 812.4 },
      { userId: 'user-marcus', requests: 15_400, inputTokens: 28_000_000, outputTokens: 4_600_000, costUsd: 588.2 },
      { userId: 'user-elena', requests: 10_200, inputTokens: 19_000_000, outputTokens: 3_100_000, costUsd: 402.1 },
      { userId: 'user-tomas', requests: 8600, inputTokens: 15_000_000, outputTokens: 2_400_000, costUsd: 268.75 },
      { userId: 'user-aisha', requests: 6800, inputTokens: 11_000_000, outputTokens: 1_800_000, costUsd: 144.55 },
    ],
  },
  projection: {
    projectedMonthlyCostUsd: 4750.0,
    dailyAverageCostUsd: 158.3,
    daysElapsed: 14,
    daysInMonth: 30,
  },
  compute: {
    totalNodeHours: 980.5,
    totalVcpuHours: 3720.4,
    estimatedCostUsd: 612.4,
    activeNodes: 4,
    vcpuHourCostUsd: 0.0165,
  },
  period: 'current-month',
  periodLabel: 'September 2026',
};

test.describe('F. Admin costs', () => {
  test('installation cost summary — LLM by model/day/user, projection, compute', async ({
    page,
  }) => {
    attachDiagnostics(page);
    await dismissOnboarding(page);
    await setupAuditRoutes(page, (path, respond) => {
      if (path === '/api/admin/costs') return respond(200, COST_SUMMARY);
      return commonChromeHandler(path, respond, {});
    });

    await page.goto('/admin/costs');
    await expect(page.getByText('Cost Monitor')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(/opus-5/).first()).toBeVisible();
    await expect(page.getByText('user-priya')).toBeVisible();
    await assertNoOverflow(page);

    await marketingShot(page, 'sam-admin-costs');
  });
});

// ---------------------------------------------------------------------------
// G. Admin → Usage (nodes by user)
// ---------------------------------------------------------------------------

const ADMIN_NODE_USAGE_RESPONSE = {
  period: USAGE_PERIOD,
  users: [
    { userId: 'user-priya', name: 'Priya Natarajan', email: 'priya@northwindlabs.dev', avatarUrl: null, totalNodeHours: 128.4, totalVcpuHours: 512.8, platformNodeHours: 100.2, activeNodes: 2 },
    { userId: 'user-marcus', name: 'Marcus Chen', email: 'marcus@northwindlabs.dev', avatarUrl: null, totalNodeHours: 84.1, totalVcpuHours: 336.2, platformNodeHours: 60.0, activeNodes: 1 },
    { userId: 'user-elena', name: 'Elena Rossi', email: 'elena@northwindlabs.dev', avatarUrl: null, totalNodeHours: 52.6, totalVcpuHours: 168.9, platformNodeHours: 20.4, activeNodes: 1 },
    { userId: 'user-tomas', name: 'Tomás Alvarez', email: 'tomas@northwindlabs.dev', avatarUrl: null, totalNodeHours: 31.7, totalVcpuHours: 95.3, platformNodeHours: 31.7, activeNodes: 0 },
    { userId: 'user-aisha', name: 'Aisha Okafor', email: 'aisha@northwindlabs.dev', avatarUrl: null, totalNodeHours: 15.2, totalVcpuHours: 45.6, platformNodeHours: 15.2, activeNodes: 0 },
  ],
};

test.describe('G. Admin usage — nodes', () => {
  test('installation node usage broken down by user', async ({ page }) => {
    attachDiagnostics(page);
    await dismissOnboarding(page);
    await setupAuditRoutes(page, (path, respond) => {
      if (path === '/api/admin/usage/nodes') return respond(200, ADMIN_NODE_USAGE_RESPONSE);
      return commonChromeHandler(path, respond, {});
    });

    await page.goto('/admin/usage');
    await expect(page.getByText('Node Usage')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole('button', { name: /Priya Natarajan/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /Aisha Okafor/ })).toBeVisible();
    await assertNoOverflow(page);

    await marketingShot(page, 'sam-admin-usage-nodes');
  });
});
