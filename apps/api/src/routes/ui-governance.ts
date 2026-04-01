import { Hono } from 'hono';

import type { Env } from '../index';
import { getUserId,requireApproved, requireAuth, requireSuperadmin } from '../middleware/auth';
import { errors } from '../middleware/error';
import {
  ComplianceRunCreateSchema,
  ComponentDefinitionCreateSchema,
  ComponentDefinitionUpdateSchema,
  ExceptionRequestCreateSchema,
  jsonValidator,
  MigrationWorkItemCreateSchema,
  MigrationWorkItemPatchSchema,
  UIStandardUpsertSchema,
} from '../schemas';
import { createUiGovernanceService } from '../services/ui-governance';

const uiGovernanceRoutes = new Hono<{ Bindings: Env }>();

// All routes require authentication + approval status
uiGovernanceRoutes.use('*', requireAuth(), requireApproved());

// --- Read endpoints: any approved user ---

uiGovernanceRoutes.get('/standards/active', async (c) => {
  const service = createUiGovernanceService(c.env.DATABASE);
  const standard = await service.getActiveStandard();
  if (!standard) {
    throw errors.notFound('Active UI standard');
  }
  return c.json(standard);
});

uiGovernanceRoutes.get('/components', async (c) => {
  const service = createUiGovernanceService(c.env.DATABASE);
  const surface = c.req.query('surface');
  const status = c.req.query('status');
  const items = await service.listComponentDefinitions(surface, status);
  return c.json({ items });
});

uiGovernanceRoutes.get('/components/:componentId', async (c) => {
  const componentId = c.req.param('componentId');
  const service = createUiGovernanceService(c.env.DATABASE);
  const component = await service.getComponentDefinition(componentId);
  if (!component) {
    throw errors.notFound('Component definition');
  }
  return c.json(component);
});

uiGovernanceRoutes.get('/compliance-runs/:runId', async (c) => {
  const runId = c.req.param('runId');
  const service = createUiGovernanceService(c.env.DATABASE);
  const run = await service.getComplianceRun(runId);
  if (!run) {
    throw errors.notFound('Compliance run');
  }
  return c.json(run);
});

uiGovernanceRoutes.get('/agent-instructions/active', async (c) => {
  const service = createUiGovernanceService(c.env.DATABASE);
  const instructions = await service.getActiveAgentInstructions();
  if (!instructions) {
    throw errors.notFound('Active agent instruction set');
  }
  return c.json(instructions);
});

// --- Write endpoints: superadmin only ---
// See AUTHZ-VULN-07 through AUTHZ-VULN-11 in Shannon security assessment.

uiGovernanceRoutes.put('/standards/:version', requireSuperadmin(), jsonValidator(UIStandardUpsertSchema), async (c) => {
  const version = c.req.param('version');
  const payload = c.req.valid('json');
  const service = createUiGovernanceService(c.env.DATABASE);
  const standard = await service.upsertStandardVersion(version, payload);
  return c.json(standard);
});

uiGovernanceRoutes.post('/components', requireSuperadmin(), jsonValidator(ComponentDefinitionCreateSchema), async (c) => {
  const payload = c.req.valid('json');
  const service = createUiGovernanceService(c.env.DATABASE);
  const component = await service.createComponentDefinition(payload);
  return c.json(component, 201);
});

uiGovernanceRoutes.put('/components/:componentId', requireSuperadmin(), jsonValidator(ComponentDefinitionUpdateSchema), async (c) => {
  const componentId = c.req.param('componentId');
  const payload = c.req.valid('json');
  const service = createUiGovernanceService(c.env.DATABASE);
  const updated = await service.updateComponentDefinition(componentId, payload);
  if (!updated) {
    throw errors.notFound('Component definition');
  }
  return c.json(updated);
});

uiGovernanceRoutes.post('/compliance-runs', requireSuperadmin(), jsonValidator(ComplianceRunCreateSchema), async (c) => {
  const payload = c.req.valid('json');
  const service = createUiGovernanceService(c.env.DATABASE);
  const run = await service.createComplianceRun(payload);
  return c.json(run, 201);
});

uiGovernanceRoutes.post('/exceptions', requireSuperadmin(), jsonValidator(ExceptionRequestCreateSchema), async (c) => {
  // Bind requestedBy to the authenticated user — never trust client-supplied identity.
  // See AUTHZ-VULN-08 in Shannon security assessment.
  const userId = getUserId(c);
  const payload = { ...c.req.valid('json'), requestedBy: userId };
  const service = createUiGovernanceService(c.env.DATABASE);
  const exception = await service.createExceptionRequest(payload);
  return c.json(exception, 201);
});

uiGovernanceRoutes.post('/migration-items', requireSuperadmin(), jsonValidator(MigrationWorkItemCreateSchema), async (c) => {
  const payload = c.req.valid('json');
  const service = createUiGovernanceService(c.env.DATABASE);
  const item = await service.createMigrationWorkItem(payload);
  return c.json(item, 201);
});

uiGovernanceRoutes.patch('/migration-items/:itemId', requireSuperadmin(), jsonValidator(MigrationWorkItemPatchSchema), async (c) => {
  const itemId = c.req.param('itemId');
  const payload = c.req.valid('json');
  const service = createUiGovernanceService(c.env.DATABASE);
  const item = await service.updateMigrationWorkItem(itemId, payload);
  if (!item) {
    throw errors.notFound('Migration work item');
  }
  return c.json(item);
});

export { uiGovernanceRoutes };
