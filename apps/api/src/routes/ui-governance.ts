import { Hono } from 'hono';
import type { Env } from '../index';
import { requireAuth } from '../middleware/auth';
import { errors } from '../middleware/error';
import {
  validateComplianceRunCreate,
  validateComponentDefinitionCreate,
  validateComponentDefinitionUpdate,
  validateExceptionRequestCreate,
  validateMigrationWorkItemCreate,
  validateMigrationWorkItemPatch,
  validateStandardUpsert,
} from './ui-governance.schemas';
import { createUiGovernanceService } from '../services/ui-governance';

const uiGovernanceRoutes = new Hono<{ Bindings: Env }>();

uiGovernanceRoutes.use('*', requireAuth());

uiGovernanceRoutes.get('/standards/active', async (c) => {
  const service = createUiGovernanceService(c.env.DATABASE);
  const standard = await service.getActiveStandard();
  if (!standard) {
    throw errors.notFound('Active UI standard');
  }
  return c.json(standard);
});

uiGovernanceRoutes.put('/standards/:version', async (c) => {
  const version = c.req.param('version');
  const payload = validateStandardUpsert(await c.req.json());
  const service = createUiGovernanceService(c.env.DATABASE);
  const standard = await service.upsertStandardVersion(version, payload);
  return c.json(standard);
});

uiGovernanceRoutes.get('/components', async (c) => {
  const service = createUiGovernanceService(c.env.DATABASE);
  const surface = c.req.query('surface');
  const status = c.req.query('status');
  const items = await service.listComponentDefinitions(surface, status);
  return c.json({ items });
});

uiGovernanceRoutes.post('/components', async (c) => {
  const payload = validateComponentDefinitionCreate(await c.req.json());
  const service = createUiGovernanceService(c.env.DATABASE);
  const component = await service.createComponentDefinition(payload);
  return c.json(component, 201);
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

uiGovernanceRoutes.put('/components/:componentId', async (c) => {
  const componentId = c.req.param('componentId');
  const payload = validateComponentDefinitionUpdate(await c.req.json());
  const service = createUiGovernanceService(c.env.DATABASE);
  const updated = await service.updateComponentDefinition(componentId, payload);
  if (!updated) {
    throw errors.notFound('Component definition');
  }
  return c.json(updated);
});

uiGovernanceRoutes.post('/compliance-runs', async (c) => {
  const payload = validateComplianceRunCreate(await c.req.json());
  const service = createUiGovernanceService(c.env.DATABASE);
  const run = await service.createComplianceRun(payload);
  return c.json(run, 201);
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

uiGovernanceRoutes.post('/exceptions', async (c) => {
  const payload = validateExceptionRequestCreate(await c.req.json());
  const service = createUiGovernanceService(c.env.DATABASE);
  const exception = await service.createExceptionRequest(payload);
  return c.json(exception, 201);
});

uiGovernanceRoutes.post('/migration-items', async (c) => {
  const payload = validateMigrationWorkItemCreate(await c.req.json());
  const service = createUiGovernanceService(c.env.DATABASE);
  const item = await service.createMigrationWorkItem(payload);
  return c.json(item, 201);
});

uiGovernanceRoutes.patch('/migration-items/:itemId', async (c) => {
  const itemId = c.req.param('itemId');
  const payload = validateMigrationWorkItemPatch(await c.req.json());
  const service = createUiGovernanceService(c.env.DATABASE);
  const item = await service.updateMigrationWorkItem(itemId, payload);
  if (!item) {
    throw errors.notFound('Migration work item');
  }
  return c.json(item);
});

uiGovernanceRoutes.get('/agent-instructions/active', async (c) => {
  const service = createUiGovernanceService(c.env.DATABASE);
  const instructions = await service.getActiveAgentInstructions();
  if (!instructions) {
    throw errors.notFound('Active agent instruction set');
  }
  return c.json(instructions);
});

export { uiGovernanceRoutes };
