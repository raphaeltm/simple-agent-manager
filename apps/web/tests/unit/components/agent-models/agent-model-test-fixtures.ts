/**
 * Shared fixtures for the AI model settings component tests: a small catalog and a project
 * settings response. Two "decision" models plus one "embeddings" model, so a one-model
 * selection always summarizes by category and a scenario can still be told apart by a model in
 * another category. Only clef-flash is on by default, so a test can turn clef-omni (which starts
 * off) on to make a real, observable change.
 */
import type {
  AgentModelCatalogEntry,
  AgentModelCatalogResponse,
  ProjectAgentModelSettingsResponse,
} from '@simple-agent-manager/shared';

function makeModel(
  overrides: Pick<AgentModelCatalogEntry, 'id' | 'name' | 'author' | 'description' | 'category'> &
    Partial<AgentModelCatalogEntry>
): AgentModelCatalogEntry {
  return {
    task: 'Text Generation',
    prices: [{ unit: 'per M input tokens', usd: 0.023 }],
    contextWindow: null,
    capabilities: [],
    beta: false,
    partner: false,
    infoUrl: null,
    termsUrl: null,
    ...overrides,
  };
}

export const TEST_MODEL_CATALOG: AgentModelCatalogResponse = {
  models: [
    makeModel({
      id: 'm-decision-1',
      name: 'clef-flash',
      author: 'cloudflare',
      description: 'Fast yes/no decisions.',
      category: 'decision',
    }),
    makeModel({
      id: 'm-decision-2',
      name: 'clef-omni',
      author: 'cloudflare',
      description: 'Broader decisions.',
      category: 'decision',
      prices: [{ unit: 'per M input tokens', usd: 0.04 }],
    }),
    makeModel({
      id: 'm-embed-1',
      name: 'bge-base',
      author: 'baai',
      description: 'Turn text into vectors.',
      category: 'embeddings',
      task: 'Text Embeddings',
      prices: [{ unit: 'per M input tokens', usd: 0.01 }],
    }),
  ],
  defaultModelIds: ['m-decision-1'],
  defaultCategories: ['decision'],
  fetchedAt: '2026-10-01T00:00:00Z',
};

export function makeTestProjectModelSettings(
  overrides: Partial<ProjectAgentModelSettingsResponse> = {}
): ProjectAgentModelSettingsResponse {
  return {
    featureEnabled: true,
    models: null,
    effectiveModelIds: ['m-decision-1'],
    effectiveSource: 'default',
    monthlyBudgetUsd: null,
    effectiveMonthlyBudgetUsd: 20,
    defaultMonthlyBudgetUsd: 20,
    maxMonthlyBudgetUsd: 100,
    usage: {
      month: '2026-10',
      spentUsd: 0,
      reservedUsd: 0,
      callCount: 0,
      resetsAt: '2026-11-01T00:00:00Z',
      byModel: [],
    },
    canEdit: true,
    ...overrides,
  };
}
