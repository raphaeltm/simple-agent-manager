/**
 * Render the `get_instructions` text inside the size budgets, with the Phase 0 size log.
 *
 * Session bootstrap must never fail because of the budget pass: if it throws, the payload is
 * rendered the pre-budget way (every policy and every ranked observation in full) and the
 * failure is logged.
 */
import type { KnowledgeEntityIndexEntry } from '../../durable-objects/project-data/knowledge';
import type { Env } from '../../env';
import { log } from '../../lib/logger';
import {
  applyInstructionBudgets,
  type BudgetedPolicy,
  type InstructionPayloadParts,
  resolveInstructionBudgets,
} from './instruction-budget';
import {
  formatKnowledgeDirectives,
  formatKnowledgeEntityIndex,
  formatPolicyDirectives,
  type KnowledgeEntry,
} from './instruction-formatting';

export async function renderWithinBudgets(input: {
  env: Env;
  projectId: string;
  contextType: string;
  policies: BudgetedPolicy[];
  knowledge: KnowledgeEntry[];
  entityIndex: KnowledgeEntityIndexEntry[];
  totalEntities: number;
  taskText: string;
  render: (parts: InstructionPayloadParts) => string;
}): Promise<string> {
  const budgets = await resolveInstructionBudgets(input.env);
  try {
    const { text, telemetry } = applyInstructionBudgets({ ...input, budgets });
    // Phase 0 telemetry: the cross-project size distribution. Policies and knowledge live in
    // each project's Durable Object, so this log is the only aggregate view of them.
    log.info('mcp.get_instructions.size', {
      projectId: input.projectId,
      contextType: input.contextType,
      ...telemetry,
      totalBudget: budgets.totalMaxChars,
      knowledgeBudget: budgets.knowledgeMaxChars,
      onDemandPolicyBudget: budgets.onDemandPolicyMaxChars,
    });
    return text;
  } catch (err) {
    log.error('mcp.get_instructions.budget_failed', {
      projectId: input.projectId,
      error: err instanceof Error ? err.message : String(err),
      action: 'rendered_without_budgets',
    });
    const knowledgeDirectives =
      [
        formatKnowledgeDirectives(input.knowledge),
        formatKnowledgeEntityIndex(input.entityIndex, input.knowledge, input.totalEntities),
      ]
        .filter((section): section is string => section !== null)
        .join('\n') || null;
    return input.render({
      policyDirectives: formatPolicyDirectives(input.policies),
      knowledgeDirectives,
      sizeNotes: [],
    });
  }
}
