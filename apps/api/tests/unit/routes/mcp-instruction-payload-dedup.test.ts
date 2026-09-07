/**
 * Regression tests for R1 (token optimization): the `get_instructions` payload must carry
 * each knowledge observation and each policy body EXACTLY ONCE.
 *
 * Before this change the response emitted `knowledgeDirectives` (rendered markdown) AND
 * `knowledgeContext` (structured JSON), plus `policyDirectives` AND `policyContext` — with
 * every observation/policy body byte-identical across the pair. On the real SAM project
 * that was ~86K chars (~21k tokens) of duplication on every single session bootstrap.
 *
 * These tests are DISCRIMINATING: `countOccurrences` returns 2 for every body on the
 * pre-fix code and 1 after. Verified by re-adding the structured arrays locally.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  selectRows: [] as unknown[][],
  drizzle: vi.fn(),
  projectData: {
    getSession: vi.fn(),
    getAllHighConfidenceKnowledge: vi.fn(),
    getKnowledgeEntityIndex: vi.fn(),
    getActivePolicies: vi.fn(),
  },
}));

vi.mock('drizzle-orm/d1', () => ({ drizzle: mocks.drizzle }));
vi.mock('../../../src/services/project-data', () => mocks.projectData);

import { handleGetInstructions } from '../../../src/routes/mcp/instruction-tools';
import type { McpTokenData } from '../../../src/services/mcp-token';

const task = {
  id: 'task-1',
  projectId: 'project-1',
  title: 'Implement bootstrap',
  description: 'Unify bootstrap',
  status: 'in_progress',
  priority: 1,
  outputBranch: 'sam/bootstrap',
  taskMode: 'task',
};

const project = {
  id: 'project-1',
  name: 'SAM',
  repository: 'owner/repo',
  defaultBranch: 'main',
  repoProvider: 'github',
};

const baseToken: McpTokenData = {
  taskId: 'task-1',
  contextType: 'task',
  taskMode: 'task',
  projectId: 'project-1',
  userId: 'user-1',
  workspaceId: 'workspace-1',
  createdAt: new Date().toISOString(),
};

/**
 * Full-length UUIDs on purpose: `update_policy` / `remove_policy` resolve the row with
 * `WHERE id = ?` (exact match), so a truncated or elided id would not address it.
 */
const POLICY_RULE_ID = '7d24e435-0153-44a6-a532-1244510d9e25';
const POLICY_CONSTRAINT_ID = '9f1c02ab-77de-4b30-8c11-3ac6d5e81b47';
const POLICY_PREFERENCE_ID = 'c3b7145e-2d80-4f6a-9e52-08bb1f7d4a10';

// Distinctive single-line ASCII bodies so occurrence counting is unambiguous under
// JSON string escaping.
const RULE_BODY = 'Agents must load SAM context before starting any work at all.';
const CONSTRAINT_BODY = 'All runtime validation uses Valibot rather than Zod in this repo.';
const PREFERENCE_BODY = 'Prefer small vertical slices over large horizontal refactors.';
const OBSERVATION_A = 'Bootstrap policy stays in the Worker control plane.';
const OBSERVATION_B = 'Raphael primarily reviews SAM from the mobile PWA.';

const POLICIES = [
  {
    id: POLICY_RULE_ID,
    category: 'rule',
    title: 'Call get_instructions first',
    content: RULE_BODY,
    confidence: 0.95,
  },
  {
    id: POLICY_CONSTRAINT_ID,
    category: 'constraint',
    title: 'Valibot not Zod',
    content: CONSTRAINT_BODY,
    confidence: 0.9,
  },
  {
    id: POLICY_PREFERENCE_ID,
    category: 'preference',
    title: 'Small vertical slices',
    content: PREFERENCE_BODY,
    confidence: 0.7,
  },
];

const OBSERVATIONS = [
  {
    entityName: 'Architecture',
    entityType: 'context',
    content: OBSERVATION_A,
    confidence: 0.95,
  },
  { entityName: 'User', entityType: 'preference', content: OBSERVATION_B, confidence: 0.9 },
];

// R3 added the knowledge entity index as a third concurrent read. These fixtures give it
// its real shape ({ entries, totalEntities }) so the de-duplication assertions below run
// against a production-shaped payload rather than a degraded one.
const ENTITY_INDEX = {
  entries: [
    { name: 'Architecture', entityType: 'context', observationCount: 1 },
    { name: 'User', entityType: 'preference', observationCount: 1 },
  ],
  totalEntities: 2,
};
const EMPTY_ENTITY_INDEX = { entries: [], totalEntities: 0 };

function makeEnv() {
  return {
    DATABASE: {},
    PROJECT_DATA: { idFromName: vi.fn().mockReturnValue('do-id'), get: vi.fn() },
  } as never;
}

function makeMockDb() {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({ limit: vi.fn(async () => mocks.selectRows.shift() ?? []) })),
      })),
    })),
  };
}

/** The exact text the agent receives over the wire. */
function serializedPayload(response: Awaited<ReturnType<typeof handleGetInstructions>>): string {
  expect(response.error).toBeUndefined();
  const result = response.result as { content: Array<{ text: string }> };
  return result.content[0]?.text ?? '';
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

async function getPayload() {
  mocks.selectRows = [[task], [project]];
  const response = await handleGetInstructions('request-1', baseToken, makeEnv());
  const text = serializedPayload(response);
  return { text, parsed: JSON.parse(text) as Record<string, unknown> };
}

describe('get_instructions payload de-duplication (R1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.selectRows = [];
    mocks.drizzle.mockReturnValue(makeMockDb());
    mocks.projectData.getSession.mockResolvedValue(null);
    mocks.projectData.getAllHighConfidenceKnowledge.mockResolvedValue(OBSERVATIONS);
    mocks.projectData.getKnowledgeEntityIndex.mockResolvedValue(ENTITY_INDEX);
    mocks.projectData.getActivePolicies.mockResolvedValue(POLICIES);
  });

  it('serializes every policy body exactly once', async () => {
    const { text } = await getPayload();

    for (const body of [RULE_BODY, CONSTRAINT_BODY, PREFERENCE_BODY]) {
      expect(countOccurrences(text, body), `policy body duplicated: ${body}`).toBe(1);
    }
  });

  it('serializes every policy title exactly once', async () => {
    const { text } = await getPayload();

    for (const policy of POLICIES) {
      expect(countOccurrences(text, policy.title), `title duplicated: ${policy.title}`).toBe(1);
    }
  });

  it('serializes every knowledge observation exactly once', async () => {
    const { text } = await getPayload();

    for (const observation of [OBSERVATION_A, OBSERVATION_B]) {
      expect(countOccurrences(text, observation), `observation duplicated`).toBe(1);
    }
  });

  it('omits the knowledgeContext and policyContext structured arrays entirely', async () => {
    const { text, parsed } = await getPayload();

    expect(parsed).not.toHaveProperty('knowledgeContext');
    expect(parsed).not.toHaveProperty('policyContext');
    // Also absent as literal keys anywhere in the serialized text.
    expect(text).not.toContain('"knowledgeContext"');
    expect(text).not.toContain('"policyContext"');

    // Liveness (rule 62 req 5): an absence assertion is also satisfied by a payload that
    // rendered nothing at all. Prove the surviving representation is actually populated.
    expect(String(parsed.knowledgeDirectives)).toContain(OBSERVATION_A);
    expect(String(parsed.policyDirectives)).toContain(RULE_BODY);
    expect(parsed.task).toMatchObject({ id: 'task-1' });
  });

  it('keeps the rendered directives as the single representation', async () => {
    const { parsed } = await getPayload();

    const knowledge = String(parsed.knowledgeDirectives);
    const policies = String(parsed.policyDirectives);

    expect(knowledge).toContain(OBSERVATION_A);
    expect(knowledge).toContain(OBSERVATION_B);
    expect(knowledge).toContain('**Architecture** (context)');

    expect(policies).toContain(RULE_BODY);
    expect(policies).toContain(CONSTRAINT_BODY);
    expect(policies).toContain(PREFERENCE_BODY);
    // Category grouping and headings survive.
    expect(policies).toContain('### Rules (MUST follow)');
    expect(policies).toContain('### Constraints (technical limitations)');
    expect(policies).toContain('### Preferences (soft guidance)');
  });
});

describe('policy management identifiers survive de-duplication', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.selectRows = [];
    mocks.drizzle.mockReturnValue(makeMockDb());
    mocks.projectData.getSession.mockResolvedValue(null);
    mocks.projectData.getAllHighConfidenceKnowledge.mockResolvedValue(OBSERVATIONS);
    mocks.projectData.getKnowledgeEntityIndex.mockResolvedValue(ENTITY_INDEX);
    mocks.projectData.getActivePolicies.mockResolvedValue(POLICIES);
  });

  it('renders every policy id inline in policyDirectives', async () => {
    const { parsed } = await getPayload();
    const policies = String(parsed.policyDirectives);

    for (const policy of POLICIES) {
      expect(policies, `missing id for ${policy.title}`).toContain(`(id: ${policy.id})`);
    }
  });

  it('renders ids in FULL so update_policy/remove_policy can resolve WHERE id = ?', async () => {
    const { parsed } = await getPayload();
    const policies = String(parsed.policyDirectives);

    // Guard against a truncated/elided rendering such as "(id: 7d24e435…)". Asserted on
    // the whole rendered block, because a capture group of [0-9a-f-]+ structurally cannot
    // contain an ellipsis and so could never catch this.
    expect(policies).not.toContain('…');
    expect(policies).not.toContain('...');

    for (const policy of POLICIES) {
      // Recover the id the way an agent would, then assert it round-trips exactly.
      const match = new RegExp(
        `\\*\\*${escapeRegExp(policy.title)}\\*\\* \\(id: ([^)]+)\\)`,
      ).exec(policies);
      expect(match, `no id captured for ${policy.title}`).not.toBeNull();
      expect(match?.[1]).toBe(policy.id);
      expect(match?.[1]).toHaveLength(36);
    }
  });

  it('binds each id to its own policy body', async () => {
    const { parsed } = await getPayload();
    const policies = String(parsed.policyDirectives);

    expect(policies).toContain(`(id: ${POLICY_RULE_ID}): ${RULE_BODY}`);
    expect(policies).toContain(`(id: ${POLICY_CONSTRAINT_ID}): ${CONSTRAINT_BODY}`);
    expect(policies).toContain(`(id: ${POLICY_PREFERENCE_ID}): ${PREFERENCE_BODY}`);
  });

  it('tells the agent where to find the policy id', async () => {
    const { parsed } = await getPayload();
    const instructions = JSON.stringify(parsed.instructions);

    expect(instructions).toContain('update_policy');
    expect(instructions).toContain('remove_policy');
    expect(instructions).toContain('(id: ...)');
  });
});

describe('empty knowledge and policy paths still degrade correctly', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.selectRows = [];
    mocks.drizzle.mockReturnValue(makeMockDb());
    mocks.projectData.getSession.mockResolvedValue(null);
  });

  it('omits both directive fields when there is nothing to render', async () => {
    mocks.projectData.getAllHighConfidenceKnowledge.mockResolvedValue([]);
    mocks.projectData.getKnowledgeEntityIndex.mockResolvedValue(EMPTY_ENTITY_INDEX);
    mocks.projectData.getActivePolicies.mockResolvedValue([]);

    const { parsed } = await getPayload();

    expect(parsed).not.toHaveProperty('knowledgeDirectives');
    expect(parsed).not.toHaveProperty('policyDirectives');
    expect(parsed).not.toHaveProperty('knowledgeContext');
    expect(parsed).not.toHaveProperty('policyContext');
    // Liveness: the response is still a real payload, not an empty/crashed one.
    expect(parsed.task).toMatchObject({ id: 'task-1' });
    expect(JSON.stringify(parsed.instructions)).toContain('no stored knowledge yet');
  });

  it('still returns knowledge directives when only policies are empty', async () => {
    mocks.projectData.getAllHighConfidenceKnowledge.mockResolvedValue(OBSERVATIONS);
    mocks.projectData.getActivePolicies.mockResolvedValue([]);

    const { parsed } = await getPayload();

    expect(String(parsed.knowledgeDirectives)).toContain(OBSERVATION_A);
    expect(parsed).not.toHaveProperty('policyDirectives');
    // The policy maintenance instructions are suppressed when there are no policies.
    expect(JSON.stringify(parsed.instructions)).not.toContain('remove_policy');
  });

  it('survives a knowledge retrieval failure without emitting either field', async () => {
    mocks.projectData.getAllHighConfidenceKnowledge.mockRejectedValue(new Error('DO down'));
    mocks.projectData.getActivePolicies.mockResolvedValue(POLICIES);

    const { parsed } = await getPayload();

    expect(parsed).not.toHaveProperty('knowledgeDirectives');
    expect(parsed).not.toHaveProperty('knowledgeContext');
    // Policies are unaffected and still carry their ids.
    expect(String(parsed.policyDirectives)).toContain(`(id: ${POLICY_RULE_ID})`);
  });

  it('survives a policy retrieval failure without emitting either field', async () => {
    // Mirror of the knowledge-failure case: production wraps both retrievals in the same
    // shape of try/catch, so both degradation paths need coverage.
    mocks.projectData.getAllHighConfidenceKnowledge.mockResolvedValue(OBSERVATIONS);
    mocks.projectData.getActivePolicies.mockRejectedValue(new Error('DO down'));

    const { parsed } = await getPayload();

    expect(parsed).not.toHaveProperty('policyDirectives');
    expect(parsed).not.toHaveProperty('policyContext');
    // Knowledge is unaffected, and the policy instructions are correctly suppressed.
    expect(String(parsed.knowledgeDirectives)).toContain(OBSERVATION_A);
    expect(JSON.stringify(parsed.instructions)).not.toContain('remove_policy');
  });
});

describe('multi-observation entities keep every observation exactly once', () => {
  // formatKnowledgeDirectives groups by entityName and joins an entity's observations with
  // ' | '. That branch is the easiest place for a future change to silently drop all but
  // the last observation, and nothing in the repo covered it.
  const SAME_ENTITY_OBS = [
    {
      entityName: 'SharedEntity',
      entityType: 'preference',
      content: 'First observation about the shared entity.',
      confidence: 0.95,
    },
    {
      entityName: 'SharedEntity',
      entityType: 'preference',
      content: 'Second observation about the shared entity.',
      confidence: 0.9,
    },
    {
      entityName: 'OtherEntity',
      entityType: 'context',
      content: 'Sole observation about the other entity.',
      confidence: 0.85,
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.selectRows = [];
    mocks.drizzle.mockReturnValue(makeMockDb());
    mocks.projectData.getSession.mockResolvedValue(null);
    mocks.projectData.getAllHighConfidenceKnowledge.mockResolvedValue(SAME_ENTITY_OBS);
    mocks.projectData.getKnowledgeEntityIndex.mockResolvedValue(ENTITY_INDEX);
    mocks.projectData.getActivePolicies.mockResolvedValue(POLICIES);
  });

  it('renders both observations of a shared entity, each exactly once', async () => {
    const { text, parsed } = await getPayload();
    const knowledge = String(parsed.knowledgeDirectives);

    for (const observation of SAME_ENTITY_OBS) {
      expect(knowledge, `dropped: ${observation.content}`).toContain(observation.content);
      expect(countOccurrences(text, observation.content)).toBe(1);
    }

    // The entity header is emitted once and both observations hang off it.
    expect(countOccurrences(knowledge, '**SharedEntity** (preference)')).toBe(1);
    expect(knowledge).toContain(
      'First observation about the shared entity. | Second observation about the shared entity.'
    );
    expect(knowledge).toContain('**OtherEntity** (context)');
  });
});
