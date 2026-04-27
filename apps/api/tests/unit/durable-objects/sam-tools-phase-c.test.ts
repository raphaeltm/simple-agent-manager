/**
 * Unit tests for SAM Phase C tools: search_knowledge, get_project_knowledge,
 * add_knowledge, list_policies, add_policy.
 *
 * Tests cover:
 * - Parameter validation (missing/invalid required params)
 * - Ownership verification (reject unowned projectId via executeTool)
 * - Successful execution with mocked service layer
 * - Cross-project search (search_knowledge without projectId)
 * - Registration in toolHandlers (executeTool dispatch)
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { executeTool } from '../../../src/durable-objects/sam-session/tools';
import { addKnowledge } from '../../../src/durable-objects/sam-session/tools/add-knowledge';
import { addPolicy } from '../../../src/durable-objects/sam-session/tools/add-policy';
import { getProjectKnowledge } from '../../../src/durable-objects/sam-session/tools/get-project-knowledge';
import { listPolicies } from '../../../src/durable-objects/sam-session/tools/list-policies';
import { searchKnowledge } from '../../../src/durable-objects/sam-session/tools/search-knowledge';
import type { CollectedToolCall, ToolContext } from '../../../src/durable-objects/sam-session/types';

// Mock cloudflare:workers
vi.mock('cloudflare:workers', () => ({
  DurableObject: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

vi.mock('../../../src/lib/secrets', () => ({
  getCredentialEncryptionKey: vi.fn().mockReturnValue('test-key'),
}));

vi.mock('../../../src/services/platform-credentials', () => ({
  getPlatformAgentCredential: vi.fn().mockResolvedValue({
    credential: 'test-api-key',
  }),
}));

// Mock the project-data service functions used by these tools
const mockSearchKnowledgeObservations = vi.fn();
const mockListKnowledgeEntities = vi.fn();
const mockGetKnowledgeEntityByName = vi.fn();
const mockCreateKnowledgeEntity = vi.fn();
const mockAddKnowledgeObservation = vi.fn();
const mockCreatePolicy = vi.fn();
const mockListPoliciesFn = vi.fn();

vi.mock('../../../src/services/project-data', () => ({
  searchKnowledgeObservations: (...args: unknown[]) => mockSearchKnowledgeObservations(...args),
  listKnowledgeEntities: (...args: unknown[]) => mockListKnowledgeEntities(...args),
  getKnowledgeEntityByName: (...args: unknown[]) => mockGetKnowledgeEntityByName(...args),
  createKnowledgeEntity: (...args: unknown[]) => mockCreateKnowledgeEntity(...args),
  addKnowledgeObservation: (...args: unknown[]) => mockAddKnowledgeObservation(...args),
  createPolicy: (...args: unknown[]) => mockCreatePolicy(...args),
  listPolicies: (...args: unknown[]) => mockListPoliciesFn(...args),
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Create a mock D1Database with `.raw()` support for drizzle ORM compatibility. */
function mockD1(options: {
  /** Results for single-row queries (drizzle .get()). Each call shifts one result. */
  rawResults?: unknown[][][];
} = {}) {
  const rawQueue = [...(options.rawResults ?? [])];

  const mockStatement = {
    bind: vi.fn().mockReturnThis(),
    first: vi.fn().mockResolvedValue(null),
    all: vi.fn().mockResolvedValue({ results: [], success: true }),
    run: vi.fn().mockResolvedValue({ success: true, meta: { changes: 1 } }),
    raw: vi.fn().mockImplementation(() => {
      const next = rawQueue.shift();
      return Promise.resolve(next ?? []);
    }),
  };
  return {
    prepare: vi.fn().mockReturnValue(mockStatement),
    _statement: mockStatement,
  };
}

function buildCtx(overrides: {
  ownedProject?: { id: string } | null;
  allProjects?: Array<{ id: string; name: string }>;
  userId?: string;
} = {}): ToolContext {
  const ownedProject = overrides.ownedProject === undefined
    ? { id: 'proj-1' }
    : overrides.ownedProject;
  const allProjects = overrides.allProjects ?? [{ id: 'proj-1', name: 'Project 1' }];

  // Build raw results queue: drizzle calls raw() for each query.
  // Single-project tools: ownership check (.get()) -> [['proj-1']] or []
  // Cross-project tools: user projects (.all()) -> [['proj-1', 'Project 1'], ...]
  // Repeat ownership result several times to handle multiple tool calls in tests.
  const ownershipRow = ownedProject ? [[ownedProject.id]] : [];
  const allProjectsRows = allProjects.map(p => [p.id, p.name]);
  const rawResults: unknown[][][] = [
    ownershipRow,
    allProjectsRows,
    ownershipRow,
    allProjectsRows,
    ownershipRow,
  ];

  const db = mockD1({ rawResults });

  return {
    env: {
      DATABASE: db as unknown,
      PROJECT_DATA: {
        idFromName: vi.fn().mockReturnValue('do-id'),
        get: vi.fn().mockReturnValue({
          fetch: vi.fn().mockResolvedValue(new Response('ok')),
          ensureProjectId: vi.fn().mockResolvedValue(undefined),
        }),
      },
    } as Record<string, unknown>,
    userId: overrides.userId ?? 'user-123',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── search_knowledge ─────────────────────────────────────────────────────────

describe('search_knowledge', () => {
  it('rejects missing query', async () => {
    const ctx = buildCtx();
    const result = await searchKnowledge({ query: '' }, ctx);
    expect(result).toEqual({ error: 'query is required.' });
  });

  it('rejects unowned projectId via executeTool', async () => {
    const ctx = buildCtx({ ownedProject: null });
    const toolCall: CollectedToolCall = {
      id: 'call-sk-1',
      name: 'search_knowledge',
      input: { query: 'test', projectId: 'not-owned' },
    };
    const result = await executeTool(toolCall, ctx);
    const r = result as { error?: string };
    expect(r.error).toBeDefined();
    expect(r.error).not.toContain('Unknown tool');
  });

  it('searches single project when projectId provided', async () => {
    const ctx = buildCtx({ ownedProject: { id: 'proj-1' } });
    mockSearchKnowledgeObservations.mockResolvedValue({
      results: [{ observation: { id: 'obs-1', content: 'test fact', confidence: 0.9 }, entityName: 'User', entityType: 'preference' }],
      total: 1,
    });

    const result = await searchKnowledge({ query: 'test', projectId: 'proj-1' }, ctx) as Record<string, unknown>;
    expect(result.projectId).toBe('proj-1');
    expect(result.total).toBe(1);
    expect(mockSearchKnowledgeObservations).toHaveBeenCalled();
  });

  it('searches all projects when projectId omitted', async () => {
    // Cross-project search: first raw() call is the user projects query (.all()),
    // so the queue must start with all-projects rows.
    const projects = [
      { id: 'proj-1', name: 'Project 1' },
      { id: 'proj-2', name: 'Project 2' },
    ];
    const db = mockD1({
      rawResults: [
        projects.map(p => [p.id, p.name]), // user projects query
      ],
    });
    const ctx: ToolContext = {
      env: {
        DATABASE: db as unknown,
        PROJECT_DATA: {
          idFromName: vi.fn().mockReturnValue('do-id'),
          get: vi.fn().mockReturnValue({
            ensureProjectId: vi.fn().mockResolvedValue(undefined),
          }),
        },
      } as Record<string, unknown>,
      userId: 'user-123',
    };

    mockSearchKnowledgeObservations.mockResolvedValue({
      results: [{ observation: { id: 'obs-1', content: 'result', confidence: 0.8 }, entityName: 'E1', entityType: 'context' }],
      total: 1,
    });

    const result = await searchKnowledge({ query: 'test' }, ctx) as Record<string, unknown>;
    expect(result.projectsSearched).toBe(2);
    expect(mockSearchKnowledgeObservations).toHaveBeenCalledTimes(2);
  });

  it('is registered in toolHandlers via executeTool', async () => {
    const ctx = buildCtx();
    const toolCall: CollectedToolCall = {
      id: 'call-sk-2',
      name: 'search_knowledge',
      input: { query: '' },
    };
    const result = await executeTool(toolCall, ctx);
    const r = result as { error?: string };
    expect(r.error).toBe('query is required.');
  });
});

// ─── get_project_knowledge ────────────────────────────────────────────────────

describe('get_project_knowledge', () => {
  it('rejects missing projectId', async () => {
    const ctx = buildCtx();
    const result = await getProjectKnowledge({ projectId: '' }, ctx);
    expect(result).toEqual({ error: 'projectId is required.' });
  });

  it('rejects unowned project via executeTool', async () => {
    const ctx = buildCtx({ ownedProject: null });
    const toolCall: CollectedToolCall = {
      id: 'call-gpk-1',
      name: 'get_project_knowledge',
      input: { projectId: 'not-owned' },
    };
    const result = await executeTool(toolCall, ctx);
    const r = result as { error?: string };
    expect(r.error).toBeDefined();
    expect(r.error).not.toContain('Unknown tool');
  });

  it('returns entities for owned project', async () => {
    const ctx = buildCtx({ ownedProject: { id: 'proj-1' } });
    mockListKnowledgeEntities.mockResolvedValue({
      entities: [{ id: 'ent-1', name: 'User', entityType: 'preference', observationCount: 3 }],
      total: 1,
    });

    const result = await getProjectKnowledge({ projectId: 'proj-1' }, ctx) as Record<string, unknown>;
    expect(result.projectId).toBe('proj-1');
    expect(result.total).toBe(1);
    expect(mockListKnowledgeEntities).toHaveBeenCalled();
  });

  it('is registered in toolHandlers via executeTool', async () => {
    const ctx = buildCtx();
    const toolCall: CollectedToolCall = {
      id: 'call-gpk-2',
      name: 'get_project_knowledge',
      input: { projectId: '' },
    };
    const result = await executeTool(toolCall, ctx);
    const r = result as { error?: string };
    expect(r.error).toBe('projectId is required.');
  });
});

// ─── add_knowledge ────────────────────────────────────────────────────────────

describe('add_knowledge', () => {
  it('rejects missing projectId', async () => {
    const ctx = buildCtx();
    const result = await addKnowledge(
      { projectId: '', entityName: 'Test', entityType: 'preference', observations: ['fact'] },
      ctx,
    );
    expect(result).toEqual({ error: 'projectId is required.' });
  });

  it('rejects missing entityName', async () => {
    const ctx = buildCtx();
    const result = await addKnowledge(
      { projectId: 'proj-1', entityName: '', entityType: 'preference', observations: ['fact'] },
      ctx,
    );
    expect(result).toEqual({ error: 'entityName is required.' });
  });

  it('rejects invalid entityType', async () => {
    const ctx = buildCtx();
    const result = await addKnowledge(
      { projectId: 'proj-1', entityName: 'Test', entityType: 'invalid', observations: ['fact'] },
      ctx,
    );
    const r = result as { error?: string };
    expect(r.error).toContain('entityType must be one of');
  });

  it('rejects empty observations array', async () => {
    const ctx = buildCtx();
    const result = await addKnowledge(
      { projectId: 'proj-1', entityName: 'Test', entityType: 'preference', observations: [] },
      ctx,
    );
    expect(result).toEqual({ error: 'observations must be a non-empty array of strings.' });
  });

  it('rejects unowned project via executeTool', async () => {
    const ctx = buildCtx({ ownedProject: null });
    const toolCall: CollectedToolCall = {
      id: 'call-ak-1',
      name: 'add_knowledge',
      input: { projectId: 'not-owned', entityName: 'Test', entityType: 'preference', observations: ['fact'] },
    };
    const result = await executeTool(toolCall, ctx);
    const r = result as { error?: string };
    expect(r.error).toBeDefined();
    expect(r.error).not.toContain('Unknown tool');
  });

  it('creates entity and adds observations for owned project', async () => {
    const ctx = buildCtx({ ownedProject: { id: 'proj-1' } });
    mockGetKnowledgeEntityByName.mockResolvedValue(null);
    mockCreateKnowledgeEntity.mockResolvedValue({ id: 'ent-new', createdAt: 1234 });
    mockAddKnowledgeObservation.mockResolvedValue({ id: 'obs-1', createdAt: 1234 });

    const result = await addKnowledge(
      { projectId: 'proj-1', entityName: 'TestEntity', entityType: 'context', observations: ['fact one', 'fact two'] },
      ctx,
    ) as Record<string, unknown>;

    expect(result.entityId).toBe('ent-new');
    expect(result.observationsAdded).toBe(2);
    expect(mockCreateKnowledgeEntity).toHaveBeenCalled();
    expect(mockAddKnowledgeObservation).toHaveBeenCalledTimes(2);
  });

  it('reuses existing entity', async () => {
    const ctx = buildCtx({ ownedProject: { id: 'proj-1' } });
    mockGetKnowledgeEntityByName.mockResolvedValue({ id: 'ent-existing' });
    mockAddKnowledgeObservation.mockResolvedValue({ id: 'obs-1', createdAt: 1234 });

    const result = await addKnowledge(
      { projectId: 'proj-1', entityName: 'ExistingEntity', entityType: 'preference', observations: ['fact'] },
      ctx,
    ) as Record<string, unknown>;

    expect(result.entityId).toBe('ent-existing');
    expect(mockCreateKnowledgeEntity).not.toHaveBeenCalled();
  });

  it('is registered in toolHandlers via executeTool', async () => {
    const ctx = buildCtx();
    const toolCall: CollectedToolCall = {
      id: 'call-ak-2',
      name: 'add_knowledge',
      input: { projectId: '', entityName: 'X', entityType: 'preference', observations: ['y'] },
    };
    const result = await executeTool(toolCall, ctx);
    const r = result as { error?: string };
    expect(r.error).toBe('projectId is required.');
  });
});

// ─── list_policies ────────────────────────────────────────────────────────────

describe('list_policies', () => {
  it('rejects missing projectId', async () => {
    const ctx = buildCtx();
    const result = await listPolicies({ projectId: '' }, ctx);
    expect(result).toEqual({ error: 'projectId is required.' });
  });

  it('rejects unowned project via executeTool', async () => {
    const ctx = buildCtx({ ownedProject: null });
    const toolCall: CollectedToolCall = {
      id: 'call-lp-1',
      name: 'list_policies',
      input: { projectId: 'not-owned' },
    };
    const result = await executeTool(toolCall, ctx);
    const r = result as { error?: string };
    expect(r.error).toBeDefined();
    expect(r.error).not.toContain('Unknown tool');
  });

  it('returns policies for owned project', async () => {
    const ctx = buildCtx({ ownedProject: { id: 'proj-1' } });
    mockListPoliciesFn.mockResolvedValue({
      policies: [{ id: 'pol-1', title: 'Test Policy', category: 'rule' }],
      total: 1,
    });

    const result = await listPolicies({ projectId: 'proj-1' }, ctx) as Record<string, unknown>;
    expect(result.projectId).toBe('proj-1');
    expect(result.total).toBe(1);
    expect(mockListPoliciesFn).toHaveBeenCalled();
  });

  it('is registered in toolHandlers via executeTool', async () => {
    const ctx = buildCtx();
    const toolCall: CollectedToolCall = {
      id: 'call-lp-2',
      name: 'list_policies',
      input: { projectId: '' },
    };
    const result = await executeTool(toolCall, ctx);
    const r = result as { error?: string };
    expect(r.error).toBe('projectId is required.');
  });
});

// ─── add_policy ───────────────────────────────────────────────────────────────

describe('add_policy', () => {
  it('rejects missing projectId', async () => {
    const ctx = buildCtx();
    const result = await addPolicy(
      { projectId: '', title: 'Test', content: 'Content', category: 'rule' },
      ctx,
    );
    expect(result).toEqual({ error: 'projectId is required.' });
  });

  it('rejects missing title', async () => {
    const ctx = buildCtx();
    const result = await addPolicy(
      { projectId: 'proj-1', title: '', content: 'Content', category: 'rule' },
      ctx,
    );
    expect(result).toEqual({ error: 'title is required.' });
  });

  it('rejects missing content', async () => {
    const ctx = buildCtx();
    const result = await addPolicy(
      { projectId: 'proj-1', title: 'Test', content: '', category: 'rule' },
      ctx,
    );
    expect(result).toEqual({ error: 'content is required.' });
  });

  it('rejects invalid category', async () => {
    const ctx = buildCtx();
    const result = await addPolicy(
      { projectId: 'proj-1', title: 'Test', content: 'Content', category: 'invalid' },
      ctx,
    );
    expect(result).toEqual({ error: 'category must be one of: rule, constraint, delegation, preference' });
  });

  it('rejects unowned project via executeTool', async () => {
    const ctx = buildCtx({ ownedProject: null });
    const toolCall: CollectedToolCall = {
      id: 'call-ap-1',
      name: 'add_policy',
      input: { projectId: 'not-owned', title: 'Test', content: 'Content', category: 'rule' },
    };
    const result = await executeTool(toolCall, ctx);
    const r = result as { error?: string };
    expect(r.error).toBeDefined();
    expect(r.error).not.toContain('Unknown tool');
  });

  it('creates policy for owned project', async () => {
    const ctx = buildCtx({ ownedProject: { id: 'proj-1' } });
    mockCreatePolicy.mockResolvedValue({ id: 'pol-new', now: '2026-04-27T00:00:00Z' });

    const result = await addPolicy(
      { projectId: 'proj-1', title: 'No force push', content: 'Never force push to main', category: 'rule' },
      ctx,
    ) as Record<string, unknown>;

    expect(result.id).toBe('pol-new');
    expect(result.category).toBe('rule');
    expect(result.title).toBe('No force push');
    expect(mockCreatePolicy).toHaveBeenCalled();
  });

  it('is registered in toolHandlers via executeTool', async () => {
    const ctx = buildCtx();
    const toolCall: CollectedToolCall = {
      id: 'call-ap-2',
      name: 'add_policy',
      input: { projectId: '', title: 'X', content: 'Y', category: 'rule' },
    };
    const result = await executeTool(toolCall, ctx);
    const r = result as { error?: string };
    expect(r.error).toBe('projectId is required.');
  });
});
