import {
  KNOWLEDGE_ENTITY_TYPES,
  KNOWLEDGE_RELATION_TYPES,
  KNOWLEDGE_SOURCE_TYPES,
  POLICY_CATEGORIES,
  POLICY_SOURCES,
} from '@simple-agent-manager/shared';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as projectDataService from '../../../src/services/project-data';

vi.mock('../../../src/services/project-data', () => ({
  addKnowledgeObservation: vi.fn(),
  createKnowledgeEntity: vi.fn(),
  createKnowledgeRelation: vi.fn(),
  createPolicy: vi.fn(),
  flagKnowledgeContradiction: vi.fn(),
  getKnowledgeEntity: vi.fn(),
  getKnowledgeEntityByName: vi.fn(),
  getKnowledgeObservationsForEntity: vi.fn(),
  getKnowledgeRelated: vi.fn(),
  getPolicy: vi.fn(),
  getRelevantKnowledge: vi.fn(),
  listKnowledgeEntities: vi.fn(),
  listPolicies: vi.fn(),
  searchKnowledgeObservations: vi.fn(),
  updatePolicy: vi.fn(),
  updateKnowledgeObservation: vi.fn(),
}));

vi.mock('../../../src/services/trial/bridge', () => ({
  bridgeKnowledgeAdded: vi.fn(),
}));

const validTokenData = {
  taskId: 'task-123',
  projectId: 'proj-456',
  userId: 'user-789',
  workspaceId: 'ws-abc',
  createdAt: new Date().toISOString(),
};

const mockKV = {
  get: vi.fn(),
  put: vi.fn().mockResolvedValue(undefined),
  delete: vi.fn(),
};

function createMockD1() {
  const stmt = {
    bind: vi.fn().mockReturnThis(),
    first: vi.fn().mockResolvedValue({ chat_session_id: 'session-1' }),
  };
  return {
    prepare: vi.fn().mockReturnValue(stmt),
    _stmt: stmt,
  };
}

let mockD1 = createMockD1();
const mockEnv = {
  KV: mockKV,
  DATABASE: mockD1 as unknown,
  PROJECT_DATA: {
    idFromName: vi.fn().mockReturnValue('do-id'),
    get: vi.fn(),
  },
  BASE_DOMAIN: 'example.com',
  KNOWLEDGE_OBSERVATION_MAX_LENGTH: '100',
  KNOWLEDGE_ENTITY_NAME_MAX_LENGTH: '30',
};

function jsonRpcRequest(method: string, params?: Record<string, unknown>) {
  return {
    jsonrpc: '2.0' as const,
    id: 1,
    method,
    ...(params ? { params } : {}),
  };
}

async function mcpPost(app: Hono, toolName: string, args: Record<string, unknown>) {
  return app.request('/mcp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer valid-token',
    },
    body: JSON.stringify(jsonRpcRequest('tools/call', {
      name: toolName,
      arguments: args,
    })),
  }, mockEnv);
}

async function listTools(app: Hono) {
  return app.request('/mcp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer valid-token',
    },
    body: JSON.stringify(jsonRpcRequest('tools/list')),
  }, mockEnv);
}

async function expectInvalidParams(res: Response, messagePart?: string) {
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.error).toBeDefined();
  expect(body.error.code).toBe(-32602);
  if (messagePart) {
    expect(body.error.message).toContain(messagePart);
  }
}

function getTool(tools: Array<{ name: string; inputSchema: { properties: Record<string, { enum?: string[] }> } }>, name: string) {
  const tool = tools.find((candidate) => candidate.name === name);
  expect(tool).toBeDefined();
  return tool;
}

describe('MCP knowledge and policy route tools', () => {
  let app: Hono;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockD1 = createMockD1();
    mockEnv.DATABASE = mockD1;
    mockKV.get.mockImplementation(async (key: string) => (
      key === 'mcp:valid-token' ? validTokenData : null
    ));

    vi.mocked(projectDataService.getKnowledgeEntityByName).mockResolvedValue(null);
    vi.mocked(projectDataService.createKnowledgeEntity).mockResolvedValue({
      id: 'entity-1',
      name: 'CodeStyle',
      entityType: 'style',
      description: null,
      observationCount: 0,
      createdAt: 1,
      updatedAt: 1,
    });
    vi.mocked(projectDataService.addKnowledgeObservation).mockResolvedValue({ id: 'obs-1', createdAt: 1 });
    vi.mocked(projectDataService.searchKnowledgeObservations).mockResolvedValue([]);
    vi.mocked(projectDataService.listKnowledgeEntities).mockResolvedValue({ entities: [], total: 0 });
    vi.mocked(projectDataService.getRelevantKnowledge).mockResolvedValue([]);
    vi.mocked(projectDataService.createKnowledgeRelation).mockResolvedValue({ id: 'rel-1', createdAt: 1 });
    vi.mocked(projectDataService.updateKnowledgeObservation).mockResolvedValue({ id: 'obs-2' });
    vi.mocked(projectDataService.flagKnowledgeContradiction).mockResolvedValue({ newObservationId: 'obs-2', relationId: 'rel-1' });
    vi.mocked(projectDataService.createPolicy).mockResolvedValue({ id: 'policy-1', now: 1 });
    vi.mocked(projectDataService.listPolicies).mockResolvedValue({ policies: [], total: 0 });

    const { mcpRoutes } = await import('../../../src/routes/mcp');
    app = new Hono();
    app.route('/mcp', mcpRoutes);
  });

  it('exposes knowledge and policy schema enums from shared constants', async () => {
    const res = await listTools(app);

    expect(res.status).toBe(200);
    const body = await res.json();
    const tools = body.result.tools as Array<{ name: string; inputSchema: { properties: Record<string, { enum?: string[] }> } }>;

    const addKnowledge = getTool(tools, 'add_knowledge');
    expect(addKnowledge?.inputSchema.properties.entityType.enum).toEqual([...KNOWLEDGE_ENTITY_TYPES]);
    expect(addKnowledge?.inputSchema.properties.sourceType.enum).toEqual([...KNOWLEDGE_SOURCE_TYPES]);
    expect(getTool(tools, 'search_knowledge')?.inputSchema.properties.entityType.enum).toEqual([...KNOWLEDGE_ENTITY_TYPES]);
    expect(getTool(tools, 'get_project_knowledge')?.inputSchema.properties.entityType.enum).toEqual([...KNOWLEDGE_ENTITY_TYPES]);
    expect(getTool(tools, 'relate_knowledge')?.inputSchema.properties.relationType.enum).toEqual([...KNOWLEDGE_RELATION_TYPES]);
    expect(getTool(tools, 'get_related')?.inputSchema.properties.relationType.enum).toEqual([...KNOWLEDGE_RELATION_TYPES]);

    const addPolicy = getTool(tools, 'add_policy');
    expect(addPolicy?.inputSchema.properties.category.enum).toEqual([...POLICY_CATEGORIES]);
    expect(addPolicy?.inputSchema.properties.source.enum).toEqual([...POLICY_SOURCES]);
    expect(getTool(tools, 'list_policies')?.inputSchema.properties.category.enum).toEqual([...POLICY_CATEGORIES]);
    expect(getTool(tools, 'update_policy')?.inputSchema.properties.category.enum).toEqual([...POLICY_CATEGORIES]);
  });

  it('returns INVALID_PARAMS for missing required knowledge and policy params', async () => {
    await expectInvalidParams(await mcpPost(app, 'add_knowledge', {
      observation: 'Uses explicit validation',
    }), 'entityName is required');

    await expectInvalidParams(await mcpPost(app, 'add_policy', {
      category: 'rule',
      content: 'Always validate inputs',
    }), 'title is required');

    await expectInvalidParams(await mcpPost(app, 'get_knowledge', {}), 'Either entityName or entityId is required');

    expect(projectDataService.addKnowledgeObservation).not.toHaveBeenCalled();
    expect(projectDataService.createPolicy).not.toHaveBeenCalled();
    expect(projectDataService.getKnowledgeEntity).not.toHaveBeenCalled();
    expect(projectDataService.getKnowledgeEntityByName).not.toHaveBeenCalled();
  });

  it('rejects invalid enum values instead of defaulting or broadening filters', async () => {
    await expectInvalidParams(await mcpPost(app, 'add_knowledge', {
      entityName: 'CodeStyle',
      observation: 'Use explicit validation',
      sourceType: 'guess',
    }), 'Invalid sourceType');

    await expectInvalidParams(await mcpPost(app, 'search_knowledge', {
      query: 'validation',
      entityType: 'everything',
    }), 'Invalid entityType');

    await expectInvalidParams(await mcpPost(app, 'get_project_knowledge', {
      entityType: 'everything',
    }), 'Invalid entityType');

    await expectInvalidParams(await mcpPost(app, 'get_related', {
      entityName: 'CodeStyle',
      relationType: 'adjacent',
    }), 'Invalid relationType');

    await expectInvalidParams(await mcpPost(app, 'list_policies', {
      category: 'all',
    }), 'category must be one of');

    expect(projectDataService.searchKnowledgeObservations).not.toHaveBeenCalled();
    expect(projectDataService.listKnowledgeEntities).not.toHaveBeenCalled();
    expect(projectDataService.getKnowledgeEntityByName).not.toHaveBeenCalled();
    expect(projectDataService.listPolicies).not.toHaveBeenCalled();
  });

  it('rejects confidence values outside 0..1 instead of clamping', async () => {
    await expectInvalidParams(await mcpPost(app, 'add_knowledge', {
      entityName: 'CodeStyle',
      observation: 'Use explicit validation',
      confidence: 1.5,
    }), 'confidence must be a number between 0.0 and 1.0');

    await expectInvalidParams(await mcpPost(app, 'search_knowledge', {
      query: 'validation',
      minConfidence: -0.1,
    }), 'minConfidence must be a number between 0.0 and 1.0');

    await expectInvalidParams(await mcpPost(app, 'update_knowledge', {
      observationId: 'obs-1',
      newContent: 'Still true',
      confidence: -1,
    }), 'confidence must be a number between 0.0 and 1.0');

    await expectInvalidParams(await mcpPost(app, 'add_policy', {
      category: 'rule',
      title: 'Validate inputs',
      content: 'Reject malformed confidence',
      confidence: 'high',
    }), 'confidence must be a number between 0.0 and 1.0');

    expect(projectDataService.addKnowledgeObservation).not.toHaveBeenCalled();
    expect(projectDataService.searchKnowledgeObservations).not.toHaveBeenCalled();
    expect(projectDataService.updateKnowledgeObservation).not.toHaveBeenCalled();
    expect(projectDataService.createPolicy).not.toHaveBeenCalled();
  });

  it('rejects invalid typed filters before querying services', async () => {
    await expectInvalidParams(await mcpPost(app, 'search_knowledge', {
      query: 'validation',
      minConfidence: 'high',
    }), 'minConfidence must be a number');

    await expectInvalidParams(await mcpPost(app, 'get_relevant_knowledge', {
      context: 'validation task',
      limit: 'many',
    }), 'limit must be a number');

    await expectInvalidParams(await mcpPost(app, 'list_policies', {
      limit: 'many',
    }), 'limit must be a number');

    await expectInvalidParams(await mcpPost(app, 'update_policy', {
      policyId: 'policy-1',
    }), 'At least one update field must be provided');

    expect(projectDataService.searchKnowledgeObservations).not.toHaveBeenCalled();
    expect(projectDataService.getRelevantKnowledge).not.toHaveBeenCalled();
    expect(projectDataService.listPolicies).not.toHaveBeenCalled();
    expect(projectDataService.updatePolicy).not.toHaveBeenCalled();
  });

  it('passes sanitized and validated add_knowledge values to ProjectData', async () => {
    const res = await mcpPost(app, 'add_knowledge', {
      entityName: '  CodeStyle  ',
      entityType: 'style',
      observation: '  Uses explicit\x01 validation  ',
      confidence: 0.9,
      sourceType: 'explicit',
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.error).toBeUndefined();
    expect(projectDataService.createKnowledgeEntity).toHaveBeenCalledWith(
      mockEnv,
      'proj-456',
      'CodeStyle',
      'style',
      null,
    );
    expect(projectDataService.addKnowledgeObservation).toHaveBeenCalledWith(
      mockEnv,
      'proj-456',
      'entity-1',
      'Uses explicit validation',
      0.9,
      'explicit',
      'session-1',
    );
  });

  it('uses add_knowledge defaults only when optional fields are omitted', async () => {
    const res = await mcpPost(app, 'add_knowledge', {
      entityName: 'Architecture',
      observation: 'Prefer provider interfaces',
    });

    expect(res.status).toBe(200);
    expect(projectDataService.createKnowledgeEntity).toHaveBeenCalledWith(
      mockEnv,
      'proj-456',
      'Architecture',
      'custom',
      null,
    );
    expect(projectDataService.addKnowledgeObservation).toHaveBeenCalledWith(
      expect.anything(),
      'proj-456',
      'entity-1',
      'Prefer provider interfaces',
      0.7,
      'inferred',
      'session-1',
    );
  });

  it('passes validated search/list limit values to ProjectData', async () => {
    await mcpPost(app, 'search_knowledge', {
      query: 'validation',
      entityType: 'context',
      minConfidence: 0.5,
      limit: 2.6,
    });

    expect(projectDataService.searchKnowledgeObservations).toHaveBeenCalledWith(
      mockEnv,
      'proj-456',
      'validation',
      'context',
      0.5,
      3,
    );

    await mcpPost(app, 'list_policies', {
      category: 'rule',
      includeInactive: true,
      limit: 2.4,
      offset: -5,
    });

    expect(projectDataService.listPolicies).toHaveBeenCalledWith(
      mockEnv,
      'proj-456',
      'rule',
      false,
      2,
      0,
    );
  });

  it('rejects over-limit knowledge update and contradiction content', async () => {
    await expectInvalidParams(await mcpPost(app, 'update_knowledge', {
      observationId: 'obs-1',
      newContent: 'x'.repeat(101),
    }), 'newContent exceeds maximum length');

    await expectInvalidParams(await mcpPost(app, 'flag_contradiction', {
      existingObservationId: 'obs-1',
      newObservation: 'x'.repeat(101),
    }), 'newObservation exceeds maximum length');

    expect(projectDataService.updateKnowledgeObservation).not.toHaveBeenCalled();
    expect(projectDataService.flagKnowledgeContradiction).not.toHaveBeenCalled();
  });
});
