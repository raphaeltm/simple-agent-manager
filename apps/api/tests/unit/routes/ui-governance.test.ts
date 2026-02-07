import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const mocks = vi.hoisted(() => {
  const requireAuth = vi.fn(
    () => async (_: unknown, next: () => Promise<void>) => {
      await next();
    }
  );
  const createUiGovernanceService = vi.fn();
  return { requireAuth, createUiGovernanceService };
});

vi.mock('../../../src/middleware/auth', () => ({
  requireAuth: mocks.requireAuth,
}));

vi.mock('../../../src/services/ui-governance', () => ({
  createUiGovernanceService: mocks.createUiGovernanceService,
}));

import { uiGovernanceRoutes } from '../../../src/routes/ui-governance';

function createMockService() {
  return {
    getActiveStandard: vi.fn(),
    upsertStandardVersion: vi.fn(),
    listComponentDefinitions: vi.fn(),
    createComponentDefinition: vi.fn(),
    getComponentDefinition: vi.fn(),
    updateComponentDefinition: vi.fn(),
    createComplianceRun: vi.fn(),
    getComplianceRun: vi.fn(),
    createExceptionRequest: vi.fn(),
    createMigrationWorkItem: vi.fn(),
    updateMigrationWorkItem: vi.fn(),
    getActiveAgentInstructions: vi.fn(),
  };
}

type MockService = ReturnType<typeof createMockService>;

function createApp(service: MockService) {
  mocks.createUiGovernanceService.mockReturnValue(service);

  const app = new Hono();
  app.onError((err, c) => {
    const appError = err as { statusCode?: number; error?: string; message?: string };
    if (typeof appError.statusCode === 'number' && typeof appError.error === 'string') {
      return c.json(
        {
          error: appError.error,
          message: appError.message ?? 'Request failed',
        },
        appError.statusCode as 400
      );
    }

    return c.json(
      {
        error: 'INTERNAL_ERROR',
        message: 'Internal server error',
      },
      500
    );
  });
  app.route('/api/ui-governance', uiGovernanceRoutes);

  return app;
}

const env = { DATABASE: {} } as { DATABASE: unknown };
const jsonHeaders = { 'Content-Type': 'application/json' };

describe('UI governance routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAuth.mockReturnValue(
      async (_: unknown, next: () => Promise<void>) => {
        await next();
      }
    );
  });

  it('returns active standard', async () => {
    const service = createMockService();
    const standard = {
      id: 'std_01',
      version: 'v1.1',
      status: 'active',
      name: 'SAM UI Standard',
      visualDirection: 'Green-forward',
      mobileFirstRulesRef: 'docs/guides/mobile-ux-guidelines.md',
      accessibilityRulesRef: 'docs/guides/ui-standards.md#accessibility-requirements',
      ownerRole: 'design-engineering-lead',
      createdAt: '2026-02-07T00:00:00.000Z',
      updatedAt: '2026-02-07T00:00:00.000Z',
    };

    service.getActiveStandard.mockResolvedValue(standard);

    const app = createApp(service);
    const response = await app.request('/api/ui-governance/standards/active', { method: 'GET' }, env);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(standard);
    expect(mocks.createUiGovernanceService).toHaveBeenCalledWith(env.DATABASE);
  });

  it('returns 404 when active standard does not exist', async () => {
    const service = createMockService();
    service.getActiveStandard.mockResolvedValue(null);

    const app = createApp(service);
    const response = await app.request('/api/ui-governance/standards/active', { method: 'GET' }, env);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: 'NOT_FOUND',
      message: 'Active UI standard not found',
    });
  });

  it('validates standard upsert payloads', async () => {
    const service = createMockService();
    const app = createApp(service);

    const response = await app.request(
      '/api/ui-governance/standards/v1.2',
      {
        method: 'PUT',
        headers: jsonHeaders,
        body: JSON.stringify({ name: 'Missing required fields' }),
      },
      env
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: 'BAD_REQUEST',
    });
    expect(service.upsertStandardVersion).not.toHaveBeenCalled();
  });

  it('upserts a standard version with validated payload', async () => {
    const service = createMockService();
    const payload = {
      status: 'review',
      name: 'SAM UI Standard',
      visualDirection: 'Green-forward',
      mobileFirstRulesRef: 'docs/guides/mobile-ux-guidelines.md',
      accessibilityRulesRef: 'docs/guides/ui-standards.md#accessibility-requirements',
      ownerRole: 'design-engineering-lead',
    };

    service.upsertStandardVersion.mockResolvedValue({
      id: 'std_02',
      version: 'v1.2',
      ...payload,
      createdAt: '2026-02-07T00:00:00.000Z',
      updatedAt: '2026-02-07T00:00:00.000Z',
    });

    const app = createApp(service);
    const response = await app.request(
      '/api/ui-governance/standards/v1.2',
      {
        method: 'PUT',
        headers: jsonHeaders,
        body: JSON.stringify(payload),
      },
      env
    );

    expect(response.status).toBe(200);
    expect(service.upsertStandardVersion).toHaveBeenCalledWith('v1.2', payload);
  });

  it('passes component list filters to the service layer', async () => {
    const service = createMockService();
    service.listComponentDefinitions.mockResolvedValue([
      {
        id: 'cmp_01',
        standardId: 'std_01',
        name: 'PrimaryButton',
        category: 'input',
        supportedSurfaces: ['control-plane'],
        requiredStates: ['default', 'loading'],
        usageGuidance: 'Use for primary CTA actions.',
        accessibilityNotes: 'Must support visible focus state.',
        mobileBehavior: 'Full-width on narrow viewports.',
        desktopBehavior: 'Auto-width with icon support.',
        status: 'ready',
      },
    ]);

    const app = createApp(service);
    const response = await app.request(
      '/api/ui-governance/components?surface=control-plane&status=ready',
      { method: 'GET' },
      env
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ items: expect.any(Array) });
    expect(service.listComponentDefinitions).toHaveBeenCalledWith('control-plane', 'ready');
  });

  it('creates component definitions', async () => {
    const service = createMockService();
    const payload = {
      standardId: 'std_01',
      name: 'PrimaryButton',
      category: 'input',
      supportedSurfaces: ['control-plane', 'agent-ui'],
      requiredStates: ['default', 'loading', 'disabled'],
      usageGuidance: 'Use this for primary actions.',
      accessibilityNotes: 'Keep visible focus and proper contrast.',
      mobileBehavior: 'Full width on narrow screens.',
      desktopBehavior: 'Auto width with icon support.',
      status: 'ready',
    };
    service.createComponentDefinition.mockResolvedValue({ id: 'cmp_02', ...payload });

    const app = createApp(service);
    const response = await app.request(
      '/api/ui-governance/components',
      {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify(payload),
      },
      env
    );

    expect(response.status).toBe(201);
    expect(service.createComponentDefinition).toHaveBeenCalledWith(payload);
    await expect(response.json()).resolves.toMatchObject({ id: 'cmp_02' });
  });

  it('returns 404 when component definition does not exist', async () => {
    const service = createMockService();
    service.getComponentDefinition.mockResolvedValue(null);

    const app = createApp(service);
    const response = await app.request('/api/ui-governance/components/cmp_missing', { method: 'GET' }, env);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: 'NOT_FOUND',
      message: 'Component definition not found',
    });
  });

  it('updates existing component definitions', async () => {
    const service = createMockService();
    service.updateComponentDefinition.mockResolvedValue({
      id: 'cmp_01',
      standardId: 'std_01',
      name: 'PrimaryButton',
      category: 'input',
      supportedSurfaces: ['control-plane'],
      requiredStates: ['default', 'loading'],
      usageGuidance: 'Use for primary CTA actions.',
      accessibilityNotes: 'Must support visible focus state.',
      mobileBehavior: 'Full-width on narrow viewports.',
      desktopBehavior: 'Auto-width with icon support.',
      status: 'ready',
    });

    const app = createApp(service);
    const response = await app.request(
      '/api/ui-governance/components/cmp_01',
      {
        method: 'PUT',
        headers: jsonHeaders,
        body: JSON.stringify({ status: 'ready', mobileBehavior: 'Full-width on mobile.' }),
      },
      env
    );

    expect(response.status).toBe(200);
    expect(service.updateComponentDefinition).toHaveBeenCalledWith(
      'cmp_01',
      expect.objectContaining({ status: 'ready' })
    );
  });

  it('returns 404 when patching a missing migration work item', async () => {
    const service = createMockService();
    service.updateMigrationWorkItem.mockResolvedValue(null);

    const app = createApp(service);
    const response = await app.request(
      '/api/ui-governance/migration-items/item_missing',
      {
        method: 'PATCH',
        headers: jsonHeaders,
        body: JSON.stringify({ status: 'planned' }),
      },
      env
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: 'NOT_FOUND',
      message: 'Migration work item not found',
    });
    expect(service.updateMigrationWorkItem).toHaveBeenCalledWith(
      'item_missing',
      expect.objectContaining({ status: 'planned' })
    );
  });

  it('creates migration work items', async () => {
    const service = createMockService();
    const payload = {
      standardId: 'std_01',
      surface: 'control-plane',
      targetRef: 'dashboard/workspace-card',
      priority: 'high',
      status: 'backlog',
      owner: 'frontend-team',
      notes: 'Batch with dashboard refresh.',
    } as const;
    service.createMigrationWorkItem.mockResolvedValue({ id: 'mig_01', ...payload });

    const app = createApp(service);
    const response = await app.request(
      '/api/ui-governance/migration-items',
      {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify(payload),
      },
      env
    );

    expect(response.status).toBe(201);
    expect(service.createMigrationWorkItem).toHaveBeenCalledWith(payload);
    await expect(response.json()).resolves.toMatchObject({ id: 'mig_01' });
  });

  it('creates compliance runs', async () => {
    const service = createMockService();
    const payload = {
      standardId: 'std_01',
      checklistVersion: 'v1',
      authorType: 'agent',
      changeRef: 'PR-123',
    } as const;

    service.createComplianceRun.mockResolvedValue({
      id: 'run_01',
      ...payload,
      status: 'queued',
      findingsJson: null,
      reviewedBy: null,
      exceptionRequestId: null,
      completedAt: null,
      createdAt: '2026-02-07T00:00:00.000Z',
    });

    const app = createApp(service);
    const response = await app.request(
      '/api/ui-governance/compliance-runs',
      {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify(payload),
      },
      env
    );

    expect(response.status).toBe(201);
    expect(service.createComplianceRun).toHaveBeenCalledWith(payload);
    await expect(response.json()).resolves.toMatchObject({ id: 'run_01' });
  });

  it('returns compliance run details', async () => {
    const service = createMockService();
    service.getComplianceRun.mockResolvedValue({
      id: 'run_02',
      standardId: 'std_01',
      checklistVersion: 'v1',
      authorType: 'human',
      changeRef: 'PR-777',
      status: 'queued',
      findingsJson: null,
      reviewedBy: null,
      exceptionRequestId: null,
      completedAt: null,
      createdAt: '2026-02-07T00:00:00.000Z',
    });

    const app = createApp(service);
    const response = await app.request('/api/ui-governance/compliance-runs/run_02', { method: 'GET' }, env);

    expect(response.status).toBe(200);
    expect(service.getComplianceRun).toHaveBeenCalledWith('run_02');
    await expect(response.json()).resolves.toMatchObject({ id: 'run_02' });
  });

  it('creates exception requests', async () => {
    const service = createMockService();
    const payload = {
      standardId: 'std_01',
      requestedBy: 'frontend-lead',
      rationale: 'Temporary campaign style divergence.',
      scope: 'landing/hero-cta',
      expirationDate: '2026-03-01',
    };
    service.createExceptionRequest.mockResolvedValue({ id: 'exc_01', ...payload, status: 'pending' });

    const app = createApp(service);
    const response = await app.request(
      '/api/ui-governance/exceptions',
      {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify(payload),
      },
      env
    );

    expect(response.status).toBe(201);
    expect(service.createExceptionRequest).toHaveBeenCalledWith(payload);
    await expect(response.json()).resolves.toMatchObject({ id: 'exc_01' });
  });

  it('returns active agent instruction set details', async () => {
    const service = createMockService();
    service.getActiveAgentInstructions.mockResolvedValue({
      id: 'inst_01',
      standardId: 'std_01',
      version: 'v1',
      instructionBlocks: ['Follow shared tokens', 'Respect mobile-first constraints'],
      examplesRef: 'docs/guides/ui-agent-guidelines.md',
      requiredChecklistVersion: 'v1',
      isActive: true,
      createdAt: '2026-02-07T00:00:00.000Z',
      updatedAt: '2026-02-07T00:00:00.000Z',
    });

    const app = createApp(service);
    const response = await app.request('/api/ui-governance/agent-instructions/active', { method: 'GET' }, env);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ id: 'inst_01', isActive: true });
  });

  it('returns 404 when no active agent instruction set exists', async () => {
    const service = createMockService();
    service.getActiveAgentInstructions.mockResolvedValue(null);

    const app = createApp(service);
    const response = await app.request('/api/ui-governance/agent-instructions/active', { method: 'GET' }, env);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: 'NOT_FOUND',
      message: 'Active agent instruction set not found',
    });
  });
});
