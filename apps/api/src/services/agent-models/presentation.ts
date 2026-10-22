/**
 * Plain-language shapes of catalog entries and access sources for agents and people.
 */
import {
  AGENT_MODEL_CATEGORY_LABELS,
  type AgentModelAccessSource,
  type AgentModelCatalogEntry,
  formatAgentModelPrice,
} from '@simple-agent-manager/shared';

/** Longest description returned in a model list; the per-model view returns it in full. */
const LIST_DESCRIPTION_MAX_CHARS = 240;

export function describeSource(source: AgentModelAccessSource): string {
  switch (source) {
    case 'skill':
      return "this agent's skill chooses its models";
    case 'profile':
      return "this agent's profile chooses its models";
    case 'project':
      return 'the project chooses the models';
    case 'default':
      return "the project uses SAM's recommended models";
  }
}

export function describePrices(model: Pick<AgentModelCatalogEntry, 'prices'>): string {
  if (model.prices.length === 0)
    return 'Price not published (a fixed estimate is charged per call)';
  return model.prices.map(formatAgentModelPrice).join(', ');
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

/** Compact entry for `list_ai_models`. */
export function listEntry(model: AgentModelCatalogEntry) {
  return {
    id: model.id,
    name: model.name,
    category: AGENT_MODEL_CATEGORY_LABELS[model.category],
    description: truncate(model.description, LIST_DESCRIPTION_MAX_CHARS),
    price: describePrices(model),
    ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
    ...(model.capabilities.length > 0 ? { capabilities: model.capabilities } : {}),
  };
}
