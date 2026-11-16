/**
 * Size budgets for the SAM MCP `get_instructions` payload (idea 01M6SPMDHY2F2BPVD933B9FYJZ).
 *
 * Read once per `get_instructions` call through `resolveAdminSettingDetailsMany`, which uses
 * the per-isolate settings cache, so a warm isolate adds no D1 round trip (rule 60).
 *
 * Rollback: set every value to its maximum. Pinned policies are never trimmed by any of
 * these, and every policy is pinned until a project admin unpins it, so at maximum budgets
 * the payload matches the pre-budget rendering (tests/workers/get-instructions-budget.test.ts).
 */
import { type AdminSettingDefinition, integerDefinition } from './admin-setting-definitions';

export const INSTRUCTION_BUDGET_DEFAULTS = {
  /** Serialized `get_instructions` text. Claude Code's default MCP output cap is 25,000 tokens. */
  totalMaxChars: 60_000,
  /** Knowledge block, entity index included. The index is kept even when it alone is larger. */
  knowledgeMaxChars: 20_000,
  /** Full text of on-demand policies that match the task. Pinned policies are not counted. */
  onDemandPolicyMaxChars: 12_000,
  /** On-demand policies one category may show in full, so preferences cannot take every slot. */
  onDemandPolicyMaxPerCategory: 5,
  /** Minimum relevance score for an on-demand policy to be shown in full (title term = 2, body term = 1). */
  onDemandPolicyMinRelevance: 2,
} as const;

export type InstructionBudgetKey = keyof typeof INSTRUCTION_BUDGET_DEFAULTS;
export type InstructionBudgetSettingName = `instructions.${InstructionBudgetKey}`;

/** Large enough to reproduce the unbudgeted payload for any project today. */
const MAX_CHARS = 2_000_000;

export const INSTRUCTION_BUDGET_SETTINGS: AdminSettingDefinition[] = [
  integerDefinition(
    'instructions.totalMaxChars',
    INSTRUCTION_BUDGET_DEFAULTS.totalMaxChars,
    'Collaboration',
    'Characters of serialized get_instructions text agents receive at session start. When over, knowledge is trimmed first, then on-demand policy text, but only if that brings the payload under this size. Pinned policies and the task are never trimmed: if they alone exceed it, everything is sent and the payload says the pinned policies exceed the budget.',
    { min: 10_000, max: MAX_CHARS }
  ),
  integerDefinition(
    'instructions.knowledgeMaxChars',
    INSTRUCTION_BUDGET_DEFAULTS.knowledgeMaxChars,
    'Collaboration',
    'Characters of project knowledge in get_instructions, including the entity index. The lowest-ranked observations are left out first and the index states how many.',
    { min: 1_000, max: MAX_CHARS }
  ),
  integerDefinition(
    'instructions.onDemandPolicyMaxChars',
    INSTRUCTION_BUDGET_DEFAULTS.onDemandPolicyMaxChars,
    'Collaboration',
    'Characters of full text for on-demand (unpinned) policies that match the session task. Every on-demand policy is still listed by title and id. Pinned policies do not count against this.',
    { min: 0, max: MAX_CHARS }
  ),
  integerDefinition(
    'instructions.onDemandPolicyMaxPerCategory',
    INSTRUCTION_BUDGET_DEFAULTS.onDemandPolicyMaxPerCategory,
    'Collaboration',
    'Most on-demand policies of one category (rule, constraint, delegation, preference) shown in full in one session.',
    { min: 0, max: 200 }
  ),
  integerDefinition(
    'instructions.onDemandPolicyMinRelevance',
    INSTRUCTION_BUDGET_DEFAULTS.onDemandPolicyMinRelevance,
    'Collaboration',
    'Relevance score an on-demand policy needs to be shown in full: 2 per distinctive title word and 1 per distinctive body word that also appears in the task title, description or session topic.',
    { min: 1, max: 100 }
  ),
];
