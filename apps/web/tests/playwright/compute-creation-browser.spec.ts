import { expect, type Page, test } from '@playwright/test';

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
const catalogs = ['hetzner', 'gcp'].map((provider) => ({
  provider,
  defaultLocation: provider === 'hetzner' ? 'nbg1' : 'europe-west1-b',
  sizes: {
    small: { vcpu: 2, ramGb: 4, price: '€4/month' },
    medium: { vcpu: 4, ramGb: 8, price: '€8/month' },
    large: { vcpu: 8, ramGb: 16, price: '€16/month' },
  },
  locations:
    provider === 'hetzner'
      ? [{ id: 'nbg1', name: 'Nuremberg', country: 'DE' }, { id: 'hel1', name: 'Helsinki', country: 'FI' }]
      : [{ id: 'europe-west1-b', name: 'Belgium', country: 'BE' }],
}));

async function openSurface(page: Page, surface: 'nodes' | 'workspace' | 'task', options: { existingNode?: boolean; rejectCreate?: boolean } = {}) {
  const writes: Array<{ path: string; body: Record<string, unknown> }> = [];
  const errors: string[] = [];
  const unexpected: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
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
    else if (path === '/api/providers/catalog') body = { catalogs };
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

test('Nodes create uses catalog size/provider/location and shows API rejection', async ({ page }) => {
  const state = await openSurface(page, 'nodes', { rejectCreate: true });
  // Empty pages have both a header action and an empty-state action. Select
  // the empty-state action deliberately; neither button submits the form.
  const emptyState = page.locator('.glass-surface').filter({
    has: page.getByRole('heading', { name: 'No nodes yet', exact: true }),
  });
  await emptyState.getByRole('button', { name: 'Create Node', exact: true }).click();
  await page.getByLabel('Cloud Provider').selectOption('gcp');
  await expect(page.getByLabel('Location', { exact: true })).toHaveValue('europe-west1-b');
  await page.getByLabel('Size', { exact: true }).selectOption('large');
  await expect(page.getByLabel('Size', { exact: true }).locator('option:checked')).toContainText('8 vCPU, 16 GB');
  await screenshot(page, 'compute-create-node-catalog');
  await assertNoOverflow(page);
  const creationForm = page.locator('.glass-surface').filter({
    has: page.getByLabel('Size', { exact: true }),
  });
  await creationForm.getByRole('button', { name: 'Create Node', exact: true }).click();
  await expect(page.getByText('Capacity changed. Please retry.', { exact: true })).toBeVisible();
  expect(state.writes).toHaveLength(1);
  expect(state.writes[0]).toMatchObject({ path: '/api/nodes', body: { provider: 'gcp', vmSize: 'large', vmLocation: 'europe-west1-b' } });
  await screenshot(page, 'compute-create-node-error');
  await assertNoOverflow(page);
  expect(state.errors).toEqual([]);
  expect(state.unexpected).toEqual([]);
});

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
