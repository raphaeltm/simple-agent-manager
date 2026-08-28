import { expect, type Page, test } from '@playwright/test';

import {
  assertNoOverflow,
  getProjectSuffix,
  jsonResponse,
  makeMockUser,
  screenshot,
  setupAuditRoutes,
} from './audit-helpers';

const TIMESTAMP = '2026-08-28T00:00:00.000Z';
const LONG_MARKER =
  'unicode Ω emoji 🚀 and xss text <script>alert("pool")</script> repeated to force wrapping '.repeat(
    3
  );

const user = makeMockUser({
  email: 'pool-user@example.com',
  name: 'Pool Scope User With A Deliberately Long Display Name',
  sessionId: 'session-pool-user',
  userId: 'pool-user',
});

const superadmin = makeMockUser({
  email: 'pool-admin@example.com',
  name: 'Pool Scope Superadmin With A Deliberately Long Display Name',
  role: 'superadmin',
  sessionId: 'session-pool-admin',
  userId: 'pool-admin',
});

function capacityCandidate(scope: 'user' | 'installation', index: number) {
  const providers = ['hetzner', 'scaleway', 'gcp', 'vultr', 'digitalocean', 'upcloud'];
  const visibleLocations = ['fsn1', 'nbg1', 'hel1', 'ash', 'hil'];
  return {
    id: `${scope}-candidate-${index}`,
    poolId: `${scope}-default-pool`,
    capacitySourceId: `${scope}-source-${index % 6}`,
    provider: index < visibleLocations.length ? 'hetzner' : providers[index % providers.length],
    location:
      index === 35
        ? `region-with-a-deliberately-long-location-name-${scope}-${LONG_MARKER}`
        : (visibleLocations[index] ?? `${scope}-region-${index}`),
    workloadRole: 'workspace',
    runtime: index % 5 === 0 ? 'cf-container' : 'vm',
    machineClass: index % 4 === 0 ? 'dedicated-vm' : 'shared-vm',
    machineSize: index % 3 === 0 ? 'small' : index % 3 === 1 ? 'medium' : 'large',
    priority: index,
    candidateOrder: index,
    status: 'active',
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  };
}

function capacitySummary(scope: 'user' | 'installation') {
  const candidates = Array.from({ length: 36 }, (_, index) => capacityCandidate(scope, index));
  return {
    pool: {
      id: `${scope}-default-pool`,
      scope,
      ownerUserId: scope === 'user' ? 'pool-user' : null,
      ownerProjectId: null,
      name:
        scope === 'user'
          ? `Personal default compute pool with very long owner-managed name — ${LONG_MARKER}`
          : `SAM installation fallback compute pool with very long admin-managed name — ${LONG_MARKER}`,
      isDefault: true,
      revision: 7,
      status: 'active',
      strategy: scope === 'user' ? 'smallest-fit' : 'pack',
      exhaustionPolicy: 'queue',
      createdAt: TIMESTAMP,
      updatedAt: TIMESTAMP,
    },
    sources: [
      {
        id: `${scope}-source-0`,
        scope,
        ownerUserId: scope === 'user' ? 'pool-user' : null,
        ownerProjectId: null,
        sourceKind: 'cloud-provider-credential',
        provider: 'hetzner',
        credentialSource: scope === 'user' ? 'user' : 'platform',
        credentialId: scope === 'user' ? 'credential-user-cloud-long-id' : null,
        platformCredentialId: scope === 'installation' ? 'platform-credential-long-id' : null,
        credentialReference:
          scope === 'user'
            ? `credentials:user-cloud-reference-${LONG_MARKER}`
            : `platform_credentials:platform-cloud-reference-${LONG_MARKER}`,
        credentialVersion: 1787875200000,
        externalSourceRef: null,
        status: 'active',
        createdAt: TIMESTAMP,
        updatedAt: TIMESTAMP,
      },
    ],
    candidates,
    activeCandidateCount: candidates.length,
  };
}

function defaultsResponse(scope: 'user' | 'installation') {
  const summary = capacitySummary(scope);
  return {
    effective: summary,
    effectiveScope: scope,
    defaults: [
      {
        scope: 'project',
        visibility: 'hidden',
        visibilityReason: 'project-context-required',
        canReconcile: false,
        summary: null,
      },
      {
        scope: 'user',
        visibility: scope === 'user' ? 'visible' : 'hidden',
        visibilityReason: scope === 'user' ? 'authenticated-user' : 'user-context-required',
        canReconcile: scope === 'user',
        summary: scope === 'user' ? summary : null,
      },
      {
        scope: 'installation',
        visibility: scope === 'installation' ? 'visible' : 'hidden',
        visibilityReason: scope === 'installation' ? 'superadmin' : 'superadmin-required',
        canReconcile: scope === 'installation',
        summary: scope === 'installation' ? summary : null,
      },
    ],
    precedence: ['project', 'user', 'installation'],
    reconciledScopes: [scope],
    policyMutationSupported: true,
  };
}

function applyDefaultsUpdate(
  current: ReturnType<typeof defaultsResponse>,
  update: {
    policy?: { strategy?: string; exhaustionPolicy?: string };
    candidates?: { id: string; status: string }[];
  }
) {
  const next = JSON.parse(JSON.stringify(current)) as ReturnType<typeof defaultsResponse>;
  const summary = next.effective;
  if (!summary) return next;

  if (update.policy?.strategy) summary.pool.strategy = update.policy.strategy;
  if (update.policy?.exhaustionPolicy) {
    summary.pool.exhaustionPolicy = update.policy.exhaustionPolicy;
  }
  for (const candidateUpdate of update.candidates ?? []) {
    const candidate = summary.candidates.find((item) => item.id === candidateUpdate.id);
    if (candidate) candidate.status = candidateUpdate.status;
  }
  summary.activeCandidateCount = summary.candidates.filter(
    (candidate) => candidate.status === 'active'
  ).length;
  summary.pool.revision += 1;
  for (const item of next.defaults) {
    if (item.summary?.pool.id === summary.pool.id) item.summary = summary;
  }
  return next;
}

async function setupCommonMocks(page: Page, authUser: unknown) {
  await page.addInitScript(() =>
    ['pool-user', 'pool-admin'].forEach((userId) =>
      localStorage.setItem(`sam-onboarding-wizard-dismissed-${userId}`, 'true')
    )
  );

  await setupAuditRoutes(page, (path, respond) => {
    if (path.startsWith('/api/auth/')) return respond(200, authUser);
    if (path.startsWith('/api/notifications')) {
      return respond(200, { notifications: [], unreadCount: 0 });
    }
    if (path === '/api/projects') return respond(200, { projects: [], nextCursor: null });
    if (path === '/api/agents') return respond(200, { agents: [] });
    if (path === '/api/credentials/agent') return respond(200, { credentials: [] });
    if (path === '/api/credentials') return respond(200, []);
    if (path.startsWith('/api/github')) return respond(200, []);
    if (path === '/api/dashboard/active-tasks') return respond(200, { tasks: [] });
    if (path === '/api/providers/catalog') return respond(200, { catalogs: [] });
    return undefined;
  });
}

async function setupUserPoolMocks(page: Page) {
  await setupCommonMocks(page, user);
  let responseBody = defaultsResponse('user');
  await page.route('**/api/capacity-pools/defaults*', async (route) => {
    if (route.request().method() === 'PATCH') {
      responseBody = applyDefaultsUpdate(responseBody, route.request().postDataJSON());
    }
    return jsonResponse(route, 200, responseBody);
  });
  await page.route('**/api/credentials', (route) => {
    if (route.request().method() !== 'GET') {
      return jsonResponse(route, 200, { id: 'credential-user-cloud-long-id' });
    }
    return jsonResponse(route, 200, [
      {
        id: 'credential-user-cloud-long-id',
        provider: 'hetzner',
        name: `Hetzner personal token with a long visible label ${LONG_MARKER}`,
        createdAt: TIMESTAMP,
        updatedAt: TIMESTAMP,
      },
    ]);
  });
  await page.route('**/api/credentials/validate', (route) =>
    jsonResponse(route, 200, {
      valid: true,
      provider: 'hetzner',
      message: 'credential validated',
    })
  );
}

async function setupInstallationPoolMocks(page: Page) {
  await setupCommonMocks(page, superadmin);
  let responseBody = defaultsResponse('installation');
  await page.route('**/api/admin/capacity-pools/defaults*', async (route) => {
    if (route.request().method() === 'PATCH') {
      responseBody = applyDefaultsUpdate(responseBody, route.request().postDataJSON());
    }
    return jsonResponse(route, 200, responseBody);
  });
  await page.route('**/api/admin/platform-credentials', (route) =>
    jsonResponse(route, 200, {
      credentials: [
        {
          id: 'platform-credential-long-id',
          credentialType: 'cloud-provider',
          provider: 'hetzner',
          agentType: null,
          credentialKind: 'api-token',
          label: `Primary Hetzner fallback platform credential ${LONG_MARKER}`,
          isEnabled: true,
          createdAt: TIMESTAMP,
          updatedAt: TIMESTAMP,
        },
      ],
    })
  );
}

async function screenshotPoolPanel(page: Page, heading: string, name: string) {
  await page.getByRole('heading', { name: heading }).scrollIntoViewIfNeeded();
  await page.waitForTimeout(600);
  const viewport = page.viewportSize();
  const suffix = viewport ? `-${viewport.width}x${viewport.height}` : '';
  await page.screenshot({
    path: `../../.codex/tmp/playwright-screenshots/${name}${suffix}.png`,
    fullPage: false,
  });
}

async function screenshotPoolDetails(page: Page, name: string) {
  await page.getByRole('heading', { name: 'Active Sources' }).scrollIntoViewIfNeeded();
  await page.waitForTimeout(600);
  const viewport = page.viewportSize();
  const suffix = viewport ? `-${viewport.width}x${viewport.height}` : '';
  await page.screenshot({
    path: `../../.codex/tmp/playwright-screenshots/${name}${suffix}.png`,
    fullPage: false,
  });
}

async function screenshotPoolEditor(page: Page, heading: string, name: string) {
  await page.getByRole('heading', { name: heading }).scrollIntoViewIfNeeded();
  await page.waitForTimeout(600);
  const viewport = page.viewportSize();
  const suffix = viewport ? `-${viewport.width}x${viewport.height}` : '';
  await page.screenshot({
    path: `../../.codex/tmp/playwright-screenshots/${name}${suffix}.png`,
    fullPage: false,
  });
}

test.describe('Default capacity pool scope surfaces', () => {
  test('user settings surface renders stressed user default pool without overflow', async ({
    page,
  }, testInfo) => {
    await setupUserPoolMocks(page);
    await page.goto('/settings/cloud-provider');

    await expect(page.getByRole('heading', { name: 'Your Default Compute Pool' })).toBeVisible();
    await expect(page.getByText(/Active candidates\s*36/)).toBeVisible();
    await expect(page.getByText('+24 more provider/region groups')).toBeVisible();
    await expect(page.getByText(/Hidden outside this settings context/i)).toHaveCount(0);
    await expect(page.getByText(/Installation defaults require/i)).toHaveCount(0);

    await screenshot(
      page,
      `default-capacity-pools-user-${getProjectSuffix(testInfo.project.name)}`
    );
    await screenshotPoolPanel(
      page,
      'Your Default Compute Pool',
      `default-capacity-pools-user-focused-${getProjectSuffix(testInfo.project.name)}`
    );
    await screenshotPoolDetails(
      page,
      `default-capacity-pools-user-details-${getProjectSuffix(testInfo.project.name)}`
    );

    await page.getByRole('button', { name: 'Edit' }).click();
    await expect(page.getByRole('heading', { name: 'Edit user default' })).toBeVisible();
    await page.getByRole('button', { name: 'Remove Hetzner ash Small candidate' }).click();
    await page.getByRole('button', { name: 'Remove Hetzner hil Medium candidate' }).click();
    await screenshotPoolEditor(
      page,
      'Edit user default',
      `default-capacity-pools-user-edit-${getProjectSuffix(testInfo.project.name)}`
    );
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText(/Active candidates\s*34/)).toBeVisible();
    await expect(page.getByText('Hetzner · ash')).toHaveCount(0);
    await expect(page.getByText('Hetzner · hil')).toHaveCount(0);
    await assertNoOverflow(page);
  });

  test('admin surface renders stressed installation default pool without overflow', async ({
    page,
  }, testInfo) => {
    await setupInstallationPoolMocks(page);
    await page.goto('/admin/credentials');

    await expect(
      page.getByRole('heading', { name: 'Installation Default Compute Pool' })
    ).toBeVisible();
    await expect(page.getByText(/Active candidates\s*36/)).toBeVisible();
    await expect(page.getByText('+24 more provider/region groups')).toBeVisible();
    await expect(page.getByText(/Hidden outside this settings context/i)).toHaveCount(0);
    await expect(page.getByText(/Installation defaults require/i)).toHaveCount(0);

    await screenshot(
      page,
      `default-capacity-pools-installation-${getProjectSuffix(testInfo.project.name)}`
    );
    await screenshotPoolPanel(
      page,
      'Installation Default Compute Pool',
      `default-capacity-pools-installation-focused-${getProjectSuffix(testInfo.project.name)}`
    );
    await screenshotPoolDetails(
      page,
      `default-capacity-pools-installation-details-${getProjectSuffix(testInfo.project.name)}`
    );

    await page.getByRole('button', { name: 'Edit' }).click();
    await expect(page.getByRole('heading', { name: 'Edit installation default' })).toBeVisible();
    await page.getByRole('button', { name: 'Remove Hetzner ash Small candidate' }).click();
    await page.getByRole('button', { name: 'Remove Hetzner hil Medium candidate' }).click();
    await screenshotPoolEditor(
      page,
      'Edit installation default',
      `default-capacity-pools-installation-edit-${getProjectSuffix(testInfo.project.name)}`
    );
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText(/Active candidates\s*34/)).toBeVisible();
    await expect(page.getByText('Hetzner · ash')).toHaveCount(0);
    await expect(page.getByText('Hetzner · hil')).toHaveCount(0);
    await assertNoOverflow(page);
  });
});
