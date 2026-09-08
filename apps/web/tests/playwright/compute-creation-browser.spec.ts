import { expect, type Page, test } from '@playwright/test';
import type { CredentialProvider, ProviderCatalog, ProviderInstanceOffering, SafeEffectiveCapacityPoolSummary } from '@simple-agent-manager/shared';

import { assertNoOverflow, makeMockUser, screenshot } from './audit-helpers';

// Use playwright.compute-creation.config.ts: this imports real components via Vite.
const project = {
  id: 'creation-project',
  name: 'Compute migration 🚀',
  repository: 'sam/migration',
  defaultBranch: 'main',
  installationId: 'installation-1',
  defaultVmSize: 'large',
  defaultProvider: 'hetzner',
  defaultLocation: 'nbg1',
  resourceRequirementsJson: '{"minMemoryGb":4}',
};
const node = {
  id: 'existing-node',
  name: 'Existing native node',
  status: 'running',
  healthStatus: 'healthy',
  nodeRole: 'workspace',
  cloudProvider: 'hetzner',
  vmSize: 'small',
  vmLocation: 'hel1',
  providerInstanceType: 'cx53',
  providerInstanceVcpuCount: 16,
  providerInstanceMemoryMb: 32768,
  providerInstanceDiskGb: 320,
  createdAt: '2026-09-07T10:00:00Z',
  updatedAt: '2026-09-07T10:00:00Z',
};
function nativeOffering(provider: CredentialProvider, location: string, instanceType: string): ProviderInstanceOffering {
  return {
    provider, location, providerInstanceType: instanceType, providerInstanceSku: null,
    displayName: instanceType, vcpu: 8, memoryMb: 32768, diskGb: 160,
    currency: 'EUR', price: '€24/month', available: true, stale: false,
    catalogSource: 'api', catalogLastSeenAt: '2026-09-08T12:00:00Z',
  };
}

const catalogs: ProviderCatalog[] = (['hetzner', 'gcp'] as const).map((provider) => ({
  provider,
  defaultLocation: provider === 'hetzner' ? 'nbg1' : 'europe-west1-b',
  sizes: {
    small: { vcpu: 2, ramGb: 4, storageGb: 40, price: '€4/month' },
    medium: { vcpu: 4, ramGb: 8, storageGb: 80, price: '€8/month' },
    large: { vcpu: 8, ramGb: 16, storageGb: 160, price: '€16/month' },
  },
  locations:
    provider === 'hetzner'
      ? [{ id: 'nbg1', name: 'Nuremberg', country: 'DE' }, { id: 'hel1', name: 'Helsinki', country: 'FI' }]
      : [{ id: 'europe-west1-b', name: 'Belgium', country: 'BE' }],
  offerings: provider === 'hetzner'
    ? [nativeOffering(provider, 'nbg1', 'cx43'), nativeOffering(provider, 'hel1', 'cpx41')]
    : [nativeOffering(provider, 'europe-west1-b', 'c3-standard-8')],
}));

async function openSurface(page: Page, surface: 'nodes' | 'workspace' | 'task', options: { existingNode?: boolean; rejectCreate?: boolean; catalogs?: ProviderCatalog[]; poolSummary?: SafeEffectiveCapacityPoolSummary } = {}) {
  const writes: Array<{ path: string; body: Record<string, unknown> }> = [];
  const errors: string[] = [];
  const unexpected: string[] = [];
  page.on('pageerror', (error) => errors.push(error.stack ?? error.message));
  await page.route('**/compute-creation-audit?**', (route) => route.fulfill({
    contentType: 'text/html',
    body: `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><script type="module">import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => (type) => type; window.__vite_plugin_react_preamble_installed__ = true;</script></head><body><div id="root"></div><script type="module" src="/tests/playwright/fixtures/compute-creation-harness.tsx"></script></body></html>`,
  }));
  await page.route('**/api/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    // Vite source module URLs can contain /lib/api/; they are not API requests.
    if (!path.startsWith('/api/')) return route.continue();
    if (route.request().method() === 'POST' && ['/api/nodes', '/api/workspaces'].includes(path)) {
      writes.push({ path, body: route.request().postDataJSON() });
      return options.rejectCreate
        ? route.fulfill({ status: 409, json: { error: 'CONFLICT', message: 'Capacity changed. Please retry.' } })
        : route.fulfill({ status: 201, json: { id: 'created-resource' } });
    }
    let body: unknown;
    if (path.startsWith('/api/auth/')) body = makeMockUser({ userId: 'creation-user', sessionId: 'creation-session', name: 'Creation audit', email: 'audit@example.com' });
    else if (path === '/api/credentials') body = [];
    // Installation compute works without a personal credential.
    else if (path === '/api/trial-status') body = { available: true, hasInfraCredential: true };
    else if (path === '/api/providers/catalog') body = { catalogs: options.catalogs ?? catalogs };
    else if (path === '/api/capacity-pools/defaults') body = { effectiveSummary: options.poolSummary ?? {
      scope: null, state: 'unconfigured', strategy: null, exhaustionPolicy: null, availableCandidateCount: 0, nativeOfferings: [],
    } };
    else if (path === '/api/github/installations') body = [{ id: 'installation-1', accountLogin: 'sam' }];
    else if (path === '/api/github/branches') body = [{ name: 'main' }];
    else if (path === '/api/projects') body = { projects: [project], hasMore: false };
    else if (path === '/api/projects/creation-project') body = project;
    else if (path.endsWith('/agent-profiles') || path.endsWith('/skills')) body = { items: [] };
    else if (path === '/api/nodes') body = options.existingNode ? [node] : [];
    else if (path === '/api/workspaces') body = [];
    else {
      unexpected.push(path);
      return route.fulfill({ status: 501, json: { message: `Unmocked API: ${path}` } });
    }
    return route.fulfill({ json: body });
  });
  await page.goto(`/compute-creation-audit?surface=${surface}`);
  return { writes, errors, unexpected };
}

async function openWorkspace(page: Page, options: { existingNode?: boolean; rejectCreate?: boolean } = {}) {
  const state = await openSurface(page, 'workspace', options);
  await page.getByLabel('Project', { exact: true }).selectOption(project.id);
  await expect(page.getByLabel('Workspace Name')).toHaveValue(`${project.name} Workspace`);
  await expect(page.getByLabel('Repository', { exact: true })).toHaveValue(project.repository);
  await expect(page.getByRole('button', { name: 'Create Workspace', exact: true })).toBeEnabled();
  return state;
}

test('Nodes create posts the selected native offering and shows API rejection', async ({ page }) => {
  const state = await openSurface(page, 'nodes', { rejectCreate: true });
  // Empty pages have both a header action and an empty-state action. Select
  // the empty-state action deliberately; neither button submits the form.
  const emptyState = page.locator('.glass-surface').filter({
    has: page.getByRole('heading', { name: 'No nodes yet', exact: true }),
  });
  await emptyState.getByRole('button', { name: 'Create Node', exact: true }).click();
  await page.getByLabel('Cloud Provider').selectOption('gcp');
  await expect(page.getByLabel('Location', { exact: true })).toHaveValue('europe-west1-b');
  await page.getByLabel('Native offering', { exact: true }).selectOption('c3-standard-8');
  await expect(page.getByLabel('Native offering', { exact: true }).locator('option:checked')).toContainText('8 vCPU');
  await expect(page.getByLabel('Selected offering resources')).toContainText('€24/month');
  await screenshot(page, 'compute-create-node-catalog');
  await assertNoOverflow(page);
  const creationForm = page.locator('.glass-surface').filter({
    has: page.getByLabel('Native offering', { exact: true }),
  });
  await creationForm.getByRole('button', { name: 'Create Node', exact: true }).click();
  await expect(page.getByText('Capacity changed. Please retry.', { exact: true })).toBeVisible();
  expect(state.writes).toHaveLength(1);
  expect(state.writes[0]).toMatchObject({ path: '/api/nodes', body: { provider: 'gcp', providerInstanceType: 'c3-standard-8', vmLocation: 'europe-west1-b' } });
  expect(state.writes[0]!.body).not.toHaveProperty('vmSize');
  await screenshot(page, 'compute-create-node-error');
  await assertNoOverflow(page);
  expect(state.errors).toEqual([]);
  expect(state.unexpected).toEqual([]);
});

async function openNodeForm(page: Page, suppliedCatalogs = catalogs) {
  const state = await openSurface(page, 'nodes', { catalogs: suppliedCatalogs });
  await page.getByRole('button', { name: 'Create Node', exact: true }).first().click();
  const form = page.locator('.glass-surface').filter({ has: page.getByLabel('Location', { exact: true }) });
  return { ...state, form, submit: form.getByRole('button', { name: 'Create Node', exact: true }) };
}

test('Nodes reset native selection when provider or location changes', async ({ page }) => {
  const state = await openNodeForm(page);
  await expect(state.submit).toBeDisabled();
  await page.getByLabel('Native offering', { exact: true }).selectOption('cx43');
  await expect(state.submit).toBeEnabled();
  await page.getByLabel('Location', { exact: true }).selectOption('hel1');
  await expect(page.getByLabel('Native offering', { exact: true })).toHaveValue('');
  await expect(state.submit).toBeDisabled();
  await expect(page.getByLabel('Native offering', { exact: true }).locator('option[value="cx43"]')).toHaveCount(0);
  await page.getByLabel('Native offering', { exact: true }).selectOption('cpx41');
  await page.getByLabel('Cloud Provider').selectOption('gcp');
  await expect(page.getByLabel('Native offering', { exact: true })).toHaveValue('');
  await expect(state.submit).toBeDisabled();
  await page.getByLabel('Native offering', { exact: true }).selectOption('c3-standard-8');
  await state.submit.click();
  expect(state.writes[0]!.body).toMatchObject({ provider: 'gcp', vmLocation: 'europe-west1-b', providerInstanceType: 'c3-standard-8' });
  expect(state.writes[0]!.body).not.toHaveProperty('vmSize');
  expect(state.errors).toEqual([]);
});

for (const selection of ['explicit', 'default'] as const) {
  test(`Nodes require explicit provider reselection after an effective pool refresh removes the ${selection} selection`, async ({ page }) => {
    const poolSummary: SafeEffectiveCapacityPoolSummary = {
      scope: 'installation', state: 'configured-ready', strategy: 'pack', exhaustionPolicy: 'fail',
      availableCandidateCount: 2,
      nativeOfferings: [nativeOffering('hetzner', 'nbg1', 'cx43'), nativeOffering('gcp', 'europe-west1-b', 'c3-standard-8')],
    };
    if (selection === 'default') poolSummary.nativeOfferings!.reverse();
    const state = await openSurface(page, 'nodes', { catalogs: [], poolSummary });
    await page.getByRole('button', { name: 'Create Node', exact: true }).first().click();
    const submit = page.getByRole('button', { name: 'Create Node', exact: true }).first();
    if (selection === 'explicit') await page.getByLabel('Cloud Provider').selectOption('gcp');
    await page.getByLabel('Native offering', { exact: true }).selectOption('c3-standard-8');
    await expect(submit).toBeEnabled();

    poolSummary.nativeOfferings = [nativeOffering('hetzner', 'nbg1', 'cx43')];
    poolSummary.availableCandidateCount = 1;
    // Refresh the real page query through its normal HTTP boundary.
    await page.evaluate(async () => {
      const modulePath = '/src/lib/query-client.ts';
      const { queryClient } = await import(modulePath);
      await queryClient.invalidateQueries();
    });
    await expect(page.getByLabel('Cloud Provider')).toHaveValue('');
    await expect(page.getByLabel('Cloud Provider').locator('option:checked')).toHaveText('Choose a provider');
    await expect(submit).toBeDisabled();
    expect(state.writes).toEqual([]);
    await page.getByLabel('Cloud Provider').selectOption('hetzner');
    await expect(page.getByLabel('Location', { exact: true })).toHaveValue('nbg1');
    await expect(page.getByLabel('Native offering', { exact: true })).toHaveValue('');
    await expect(submit).toBeDisabled();
    await page.getByLabel('Native offering', { exact: true }).selectOption('cx43');
    await submit.click();
    expect(state.writes).toHaveLength(1);
    expect(state.writes[0]!.body).toMatchObject({ provider: 'hetzner', vmLocation: 'nbg1', providerInstanceType: 'cx43' });
    expect(state.writes[0]!.body).not.toHaveProperty('vmSize');
    expect(state.errors).toEqual([]);
    expect(state.unexpected).toEqual([]);
  });
}

for (const mode of ['empty', 'unavailable', 'stale'] as const) {
  test(`Nodes ${mode} native offerings cannot create or silently use legacy sizes`, async ({ page }) => {
    const supplied = structuredClone(catalogs);
    supplied[0]!.offerings = mode === 'empty' ? [] : [
      { ...nativeOffering('hetzner', 'nbg1', 'cx43'), available: mode !== 'unavailable', stale: mode === 'stale' },
    ];
    const state = await openNodeForm(page, supplied);
    await expect(state.submit).toBeDisabled();
    await expect(page.getByText('No available native offerings in this location.', { exact: true })).toBeVisible();
    await expect(page.getByLabel('Compatibility preset', { exact: true })).toHaveCount(0);
    await screenshot(page, `compute-create-node-${mode}`);
    await assertNoOverflow(page);
    expect(state.writes).toEqual([]);
    expect(state.errors).toEqual([]);
  });
}

test('Nodes old catalogs require explicit compatibility opt-in', async ({ page }) => {
  const supplied = structuredClone(catalogs);
  delete supplied[0]!.offerings;
  const state = await openNodeForm(page, supplied);
  await expect(state.submit).toBeDisabled();
  await page.getByLabel('Use a legacy compatibility preset').check();
  await page.getByLabel('Compatibility preset', { exact: true }).selectOption('small');
  await screenshot(page, 'compute-create-node-compatibility');
  await assertNoOverflow(page);
  await state.submit.click();
  expect(state.writes[0]!.body).toMatchObject({ provider: 'hetzner', vmLocation: 'nbg1', vmSize: 'small' });
  expect(state.writes[0]!.body).not.toHaveProperty('providerInstanceType');
  expect(state.errors).toEqual([]);
});

test('Nodes native catalog supports long, many and special-character offerings without overflow', async ({ page }) => {
  const supplied = structuredClone(catalogs);
  supplied[0]!.offerings = Array.from({ length: 35 }, (_, index) => ({
    ...nativeOffering('hetzner', 'nbg1', `native-${index}`),
    displayName: index === 0 ? 'A' : index === 1 ? 'Large native offering 🚀 <script>alert(1)</script> '.repeat(6) : `Offering ${index}`,
  }));
  const state = await openNodeForm(page, supplied);
  await expect(page.getByLabel('Native offering', { exact: true }).locator('option')).toHaveCount(36);
  await page.getByLabel('Native offering', { exact: true }).selectOption('native-1');
  await expect(page.getByLabel('Native offering', { exact: true }).locator('option:checked')).toContainText('native-1');
  await screenshot(page, 'compute-create-node-long-many');
  await assertNoOverflow(page);
  await page.setViewportSize({ width: 320, height: 667 });
  await assertNoOverflow(page);
  await screenshot(page, 'compute-create-node-long-many');
  await state.submit.click();
  expect(state.writes[0]!.body.providerInstanceType).toBe('native-1');
  expect(state.errors).toEqual([]);
});

test('Nodes select installation-funded native capacity without a personal credential catalog', async ({ page }) => {
  const state = await openSurface(page, 'nodes', { catalogs: [], poolSummary: {
    scope: 'installation', state: 'configured-ready', strategy: 'pack', exhaustionPolicy: 'fail', availableCandidateCount: 1,
    nativeOfferings: [{ provider: 'hetzner', location: 'nbg1', providerInstanceType: 'cx43', displayName: 'CX43', vcpu: 8, memoryMb: 16384, diskGb: 160, price: '€24/month' }],
  } });
  await page.getByRole('button', { name: 'Create Node', exact: true }).first().click();
  await expect(page.getByText('Installation-funded compute', { exact: true })).toBeVisible();
  await page.getByLabel('Native offering', { exact: true }).selectOption('cx43');
  await screenshot(page, 'compute-create-node-installation');
  await assertNoOverflow(page);
  const form = page.locator('.glass-surface').filter({ has: page.getByLabel('Native offering', { exact: true }) });
  await form.getByRole('button', { name: 'Create Node', exact: true }).click();
  expect(state.writes[0]!.body).toMatchObject({ provider: 'hetzner', vmLocation: 'nbg1', providerInstanceType: 'cx43' });
  expect(state.writes[0]!.body).not.toHaveProperty('vmSize');
  expect(state.errors).toEqual([]);
  expect(state.unexpected).toEqual([]);
});

for (const poolState of ['configured-empty', 'migration-pending', 'source-disabled'] as const) {
  test(`Nodes ${poolState} effective pool blocks personal catalog fallback`, async ({ page }) => {
    const state = await openSurface(page, 'nodes', { poolSummary: {
      scope: 'user', state: poolState, strategy: 'pack', exhaustionPolicy: 'fail', availableCandidateCount: 0, nativeOfferings: [],
    } });
    await page.getByRole('button', { name: 'Create Node', exact: true }).first().click();
    await expect(page.getByRole('button', { name: 'Create Node', exact: true }).first()).toBeDisabled();
    await expect(page.getByLabel('Native offering', { exact: true })).toHaveCount(0);
    await screenshot(page, `compute-create-node-pool-${poolState}`);
    await assertNoOverflow(page);
    expect(state.writes).toEqual([]);
    expect(state.errors).toEqual([]);
  });
}

for (const mode of ['blank', 'partial', 'cleared'] as const) {
  test(`CreateWorkspace ${mode} resources preserve inheritance and native request semantics`, async ({ page }) => {
    const state = await openWorkspace(page);
    await expect(page.getByLabel('vCPU', { exact: true })).toHaveValue('');
    await expect(page.getByLabel('Memory (GB)')).toHaveValue('');
    if (mode !== 'blank') {
      await page.getByLabel('vCPU', { exact: true }).fill('2.5');
      await page.getByLabel('Disk (GB)').fill('20');
      await page.getByLabel('Exclusive node').click();
      if (mode === 'cleared') {
        await page.getByRole('button', { name: 'Inherit project default' }).click();
        await expect(page.getByLabel('vCPU', { exact: true })).toHaveValue('');
        await expect(page.getByLabel('Disk (GB)')).toHaveValue('');
        expect(await page.getByLabel('Exclusive node').evaluate((el) => (el as HTMLInputElement).indeterminate)).toBe(true);
      }
    }
    await page.getByRole('button', { name: 'Create Workspace', exact: true }).scrollIntoViewIfNeeded();
    await screenshot(page, `compute-create-workspace-${mode}`);
    await assertNoOverflow(page);
    await page.getByRole('button', { name: 'Create Workspace', exact: true }).click();
    await expect(page.getByTestId('destination')).toHaveText('/workspaces/created-resource');
    expect(state.writes).toHaveLength(1);
    const payload = state.writes[0]!.body;
    expect(payload).toMatchObject({ projectId: project.id, repository: project.repository, provider: 'hetzner', vmLocation: 'nbg1' });
    expect(payload).not.toHaveProperty('vmSize');
    if (mode === 'partial') expect(payload.resourceRequirements).toEqual({ minVcpu: 2.5, minDiskGb: 20, exclusiveNode: true });
    else expect(payload).not.toHaveProperty('resourceRequirements');
    expect(state.errors).toEqual([]);
    expect(state.unexpected).toEqual([]);
  });
}

test('CreateWorkspace explicit node omits hidden resource overrides and provider authority', async ({ page }) => {
  const state = await openWorkspace(page, { existingNode: true });
  await page.getByLabel('vCPU', { exact: true }).fill('3');
  await page.getByLabel('Node', { exact: true }).selectOption(node.id);
  await expect(page.getByLabel('vCPU', { exact: true })).toHaveCount(0);
  await screenshot(page, 'compute-create-workspace-existing-node');
  await assertNoOverflow(page);
  await page.getByRole('button', { name: 'Create Workspace', exact: true }).click();
  await expect(page.getByTestId('destination')).toHaveText('/workspaces/created-resource');
  expect(state.writes).toHaveLength(1);
  expect(state.writes[0]!.body).toMatchObject({ nodeId: node.id, vmLocation: 'hel1' });
  for (const field of ['vmSize', 'provider', 'resourceRequirements']) expect(state.writes[0]!.body).not.toHaveProperty(field);
  expect(state.errors).toEqual([]);
  expect(state.unexpected).toEqual([]);
});

test('CreateWorkspace invalid number blocks submission and API error retains values', async ({ page }) => {
  const state = await openWorkspace(page, { rejectCreate: true });
  await page.getByLabel('vCPU', { exact: true }).fill('-1');
  await page.getByRole('button', { name: 'Create Workspace', exact: true }).click();
  expect(await page.getByLabel('vCPU', { exact: true }).evaluate((el) => (el as HTMLInputElement).validity.rangeUnderflow)).toBe(true);
  expect(state.writes).toHaveLength(0);
  await page.getByLabel('vCPU', { exact: true }).fill('2.5');
  await page.getByRole('button', { name: 'Create Workspace', exact: true }).click();
  await expect(page.getByText('Capacity changed. Please retry.', { exact: true })).toBeVisible();
  await expect(page.getByLabel('vCPU', { exact: true })).toHaveValue('2.5');
  expect(state.writes).toHaveLength(1);
  await screenshot(page, 'compute-create-workspace-error');
  await assertNoOverflow(page);
  expect(state.errors).toEqual([]);
  expect(state.unexpected).toEqual([]);
});

test('unused standalone TaskSubmitForm validates then emits fractional resources and clears to inheritance', async ({ page }) => {
  const state = await openSurface(page, 'task');
  const title = page.getByPlaceholder('Describe the task for the agent...');
  await title.fill('Compile migration 🚀 <script>');
  await page.getByRole('button', { name: 'Show advanced options' }).click();
  await page.getByLabel('vCPU', { exact: true }).fill('-1');
  await page.getByRole('button', { name: 'Run Now', exact: true }).click();
  await expect(page.getByTestId('task-submission')).toBeEmpty();
  await expect(page.getByText(/minVcpu must be/)).toBeVisible();
  await screenshot(page, 'compute-task-submit-invalid');
  await page.getByLabel('vCPU', { exact: true }).fill('2.5');
  await page.getByLabel('Memory (GB)').fill('6');
  await page.getByLabel('Exclusive node').click();
  await screenshot(page, 'compute-task-submit-resources');
  await assertNoOverflow(page);
  await page.getByRole('button', { name: 'Run Now', exact: true }).click();
  await expect(page.getByTestId('task-submission')).toContainText('"action":"run"');
  expect(JSON.parse(await page.getByTestId('task-submission').innerText())).toEqual({
    action: 'run', title: 'Compile migration 🚀 <script>',
    options: { resourceRequirements: { minVcpu: 2.5, minMemoryGb: 6, exclusiveNode: true } },
  });
  await expect(title).toHaveValue('');
  await expect(page.getByLabel('vCPU', { exact: true })).toHaveValue('');
  await title.fill('Save inherited task');
  await page.getByLabel('vCPU', { exact: true }).fill('4');
  await page.getByRole('button', { name: 'Inherit project default' }).click();
  await page.getByRole('button', { name: 'More options' }).click();
  await page.getByRole('button', { name: 'Save to Backlog' }).click();
  await expect(page.getByTestId('task-submission')).toContainText('"action":"backlog"');
  expect(JSON.parse(await page.getByTestId('task-submission').innerText())).toEqual({ action: 'backlog', title: 'Save inherited task', options: {} });
  expect(state.errors).toEqual([]);
  expect(state.unexpected).toEqual([]);
});
