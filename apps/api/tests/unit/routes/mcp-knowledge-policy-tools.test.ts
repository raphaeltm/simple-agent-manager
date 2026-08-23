import {
  KNOWLEDGE_ENTITY_TYPES,
  KNOWLEDGE_RELATION_TYPES,
  KNOWLEDGE_SOURCE_TYPES,
  POLICY_CATEGORIES,
  POLICY_SCOPES,
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

  it('advertises the lifecycle fields on add_policy and update_policy', async () => {
    // An agent can only set an expiry if the tool schema tells it the field exists —
    // this is what makes the capture instruction in get_instructions actionable.
    const res = await listTools(app);
    const body = await res.json();
    const tools = body.result.tools as Array<{
      name: string;
      description: string;
      inputSchema: { properties: Record<string, { enum?: string[]; description?: string }> };
    }>;

    for (const name of ['add_policy', 'update_policy']) {
      const tool = getTool(tools, name);
      expect(tool?.inputSchema.properties.scope?.enum).toEqual([...POLICY_SCOPES]);
      expect(tool?.inputSchema.properties.expiresAt).toBeDefined();
      expect(tool?.inputSchema.properties.scope?.description).toMatch(/REQUIRES expiresAt/);
    }

    // The description has to steer an agent toward expiring one-shot policies.
    expect(getTool(tools, 'add_policy')?.description).toMatch(/scope to "task"/);
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

    await expectInvalidParams(await mcpPost(app, 'relate_knowledge', {
      sourceEntity: 'CodeStyle',
      targetEntity: 'Tests',
      relationType: 'adjacent',
    }), 'Invalid relationType');

    await expectInvalidParams(await mcpPost(app, 'list_policies', {
      category: 'all',
    }), 'category must be one of');

    await expectInvalidParams(await mcpPost(app, 'add_policy', {
      category: 'rule',
      title: 'Validate inputs',
      content: 'Reject malformed source',
      source: 'guessed',
    }), 'source must be one of');

    expect(projectDataService.searchKnowledgeObservations).not.toHaveBeenCalled();
    expect(projectDataService.listKnowledgeEntities).not.toHaveBeenCalled();
    expect(projectDataService.getKnowledgeEntityByName).not.toHaveBeenCalled();
    expect(projectDataService.listPolicies).not.toHaveBeenCalled();
    expect(projectDataService.createKnowledgeRelation).not.toHaveBeenCalled();
    expect(projectDataService.createPolicy).not.toHaveBeenCalled();
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

    await expectInvalidParams(await mcpPost(app, 'add_policy', {
      category: 'rule',
      title: 'Validate inputs',
      content: 'Reject out-of-range confidence',
      confidence: 1.5,
    }), 'confidence must be a number between 0.0 and 1.0');

    expect(projectDataService.addKnowledgeObservation).not.toHaveBeenCalled();
    expect(projectDataService.searchKnowledgeObservations).not.toHaveBeenCalled();
    expect(projectDataService.updateKnowledgeObservation).not.toHaveBeenCalled();
    expect(projectDataService.createPolicy).not.toHaveBeenCalled();
  });

  it('passes sanitized and validated add_policy values to ProjectData', async () => {
    const res = await mcpPost(app, 'add_policy', {
      category: 'rule',
      title: '  Validate inputs  ',
      content: '  Reject malformed\x01 JSON-RPC params  ',
      source: 'explicit',
      confidence: 0.8,
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.error).toBeUndefined();
    expect(projectDataService.createPolicy).toHaveBeenCalledWith(
      mockEnv,
      'proj-456',
      'rule',
      'Validate inputs',
      'Reject malformed JSON-RPC params',
      'explicit',
      'task-123',
      0.8,
      // Lifecycle defaults: a policy created without scope/expiry is a standing one,
      // which is exactly what every policy created before this feature was.
      'always',
      null,
    );
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

  describe('policy lifecycle (expiry + scope)', () => {
    it('rejects a task-scoped policy with no expiry before touching ProjectData', async () => {
      // The failure this feature exists to prevent: capturing a one-shot workflow
      // constraint as a policy that then loads into every future session forever.
      await expectInvalidParams(await mcpPost(app, 'add_policy', {
        category: 'constraint',
        title: 'Use profile X for the reliability wave',
        content: 'Applies to the 2026-08-21 workstream only.',
        scope: 'task',
      }), 'task-scoped policy must set expiresAt');

      expect(projectDataService.createPolicy).not.toHaveBeenCalled();
    });

    it('rejects an expiry in the past', async () => {
      await expectInvalidParams(await mcpPost(app, 'add_policy', {
        category: 'rule',
        title: 'Already lapsed',
        content: 'Content',
        expiresAt: Date.now() - 1000,
      }), 'must be in the future');

      expect(projectDataService.createPolicy).not.toHaveBeenCalled();
    });

    it('rejects an unknown scope', async () => {
      await expectInvalidParams(await mcpPost(app, 'add_policy', {
        category: 'rule',
        title: 'Bad scope',
        content: 'Content',
        scope: 'forever',
      }), 'scope must be one of');

      expect(projectDataService.createPolicy).not.toHaveBeenCalled();
    });

    it('rejects a non-numeric expiry', async () => {
      await expectInvalidParams(await mcpPost(app, 'add_policy', {
        category: 'rule',
        title: 'Bad expiry',
        content: 'Content',
        expiresAt: 'next week',
      }), 'expiresAt must be a number');

      expect(projectDataService.createPolicy).not.toHaveBeenCalled();
    });

    it('forwards a valid task-scoped policy with its expiry to ProjectData', async () => {
      const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000;
      const res = await mcpPost(app, 'add_policy', {
        category: 'constraint',
        title: 'Use profile X for the reliability wave',
        content: 'Applies to the 2026-08-21 workstream only.',
        scope: 'task',
        expiresAt,
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.error).toBeUndefined();
      expect(projectDataService.createPolicy).toHaveBeenCalledWith(
        mockEnv,
        'proj-456',
        'constraint',
        'Use profile X for the reliability wave',
        'Applies to the 2026-08-21 workstream only.',
        'explicit',
        'task-123',
        expect.any(Number),
        'task',
        expiresAt,
      );
    });

    it('validates an update against the merged post-write state, not the patch alone', async () => {
      // Stripping the expiry off a policy that is already task-scoped must fail even
      // though the patch itself mentions no scope.
      vi.mocked(projectDataService.getPolicy).mockResolvedValue({
        id: 'pol-1',
        category: 'constraint',
        title: 'One-shot',
        content: 'Content',
        source: 'explicit',
        sourceSessionId: null,
        confidence: 0.9,
        active: true,
        scope: 'task',
        expiresAt: Date.now() + 60_000,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      } as Awaited<ReturnType<typeof projectDataService.getPolicy>>);

      await expectInvalidParams(await mcpPost(app, 'update_policy', {
        policyId: 'pol-1',
        expiresAt: null,
      }), 'task-scoped policy must set expiresAt');

      expect(projectDataService.updatePolicy).not.toHaveBeenCalled();
    });

    it('maps the DO guard rejection to INVALID_PARAMS rather than crashing', async () => {
      // Production RPC fidelity: a DO-thrown error reaches this handler as a plain
      // Error carrying only name and message (rule 63), so the mapping must be
      // message-based. Without the try/catch this rejection escapes the handler.
      vi.mocked(projectDataService.getPolicy).mockResolvedValue({
        id: 'pol-3',
        scope: 'always',
        expiresAt: null,
      } as Awaited<ReturnType<typeof projectDataService.getPolicy>>);
      vi.mocked(projectDataService.updatePolicy).mockRejectedValue(
        new Error(
          "a task-scoped policy must set expiresAt so it cannot outlive the work it was captured for (use scope 'always' for a standing policy)"
        )
      );

      await expectInvalidParams(await mcpPost(app, 'update_policy', {
        policyId: 'pol-3',
        scope: 'task',
        expiresAt: Date.now() + 60_000,
      }), 'task-scoped policy must set expiresAt');
    });

    it('allows clearing the expiry when the scope is widened in the same update', async () => {
      vi.mocked(projectDataService.getPolicy).mockResolvedValue({
        id: 'pol-2',
        category: 'constraint',
        title: 'One-shot',
        content: 'Content',
        source: 'explicit',
        sourceSessionId: null,
        confidence: 0.9,
        active: true,
        scope: 'task',
        expiresAt: Date.now() + 60_000,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      } as Awaited<ReturnType<typeof projectDataService.getPolicy>>);
      vi.mocked(projectDataService.updatePolicy).mockResolvedValue(true);

      const res = await mcpPost(app, 'update_policy', {
        policyId: 'pol-2',
        scope: 'always',
        expiresAt: null,
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.error).toBeUndefined();
      expect(projectDataService.updatePolicy).toHaveBeenCalledWith(
        mockEnv,
        'proj-456',
        'pol-2',
        expect.objectContaining({ scope: 'always', expiresAt: null }),
      );
    });

    it('does not read the stored policy when the update touches no lifecycle field', async () => {
      // Guards the I/O budget (rule 60) on the path agents actually call at runtime.
      // The extra getPolicy round-trip exists only to merge scope and expiry against
      // stored state, so an ordinary active/title edit must not pay for it. The REST
      // route has the twin of this test in tests/unit/routes/policies.test.ts.
      vi.mocked(projectDataService.updatePolicy).mockResolvedValue(true);

      const res = await mcpPost(app, 'update_policy', {
        policyId: 'pol-3',
        active: false,
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.error).toBeUndefined();
      expect(projectDataService.getPolicy).not.toHaveBeenCalled();
    });
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
