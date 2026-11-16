/**
 * Size budgets for `get_instructions` (idea 01M6SPMDHY2F2BPVD933B9FYJZ).
 *
 * Policies have an explicit inject mode. Pinned policies are always rendered in full and are
 * never trimmed by any budget. On-demand policies are always listed by title and id in a
 * disclosed index, and shown in full only when they rank as relevant to the session's task,
 * inside `instructions.onDemandPolicyMaxChars` (rule 65: rank by purpose, cap per group,
 * disclose what was left out). Knowledge keeps its existing ranking and gets a size budget
 * on top; its entity index is the disclosure and is never dropped.
 *
 * Everything here is pure over rows that were already read, so `handleGetInstructions` can
 * run it inside a try/catch and fall back to the unbudgeted rendering if it ever throws.
 */
import { formatPolicyDirectiveLine, formatPolicyIndexLine } from '@simple-agent-manager/shared';

import type { KnowledgeEntityIndexEntry } from '../../durable-objects/project-data/knowledge';
import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { resolveAdminSettingDetailsMany } from '../../services/admin-settings';
import {
  INSTRUCTION_BUDGET_DEFAULTS,
  type InstructionBudgetKey,
} from '../../services/admin-settings-instructions-definitions';
import {
  formatKnowledgeDirectives,
  formatKnowledgeEntityIndex,
  formatPolicyDirectives as formatPolicyDirectivesFor,
  type KnowledgeEntry,
  type PolicyEntry,
} from './instruction-formatting';

export type InstructionBudgets = { [K in InstructionBudgetKey]: number };

const BUDGET_KEYS = Object.keys(INSTRUCTION_BUDGET_DEFAULTS) as InstructionBudgetKey[];

/**
 * Resolve the five budgets in one cached settings read. A settings outage must not take down
 * session bootstrap, so it degrades to the code defaults with a warning.
 */
export async function resolveInstructionBudgets(env: Env): Promise<InstructionBudgets> {
  const budgets: InstructionBudgets = { ...INSTRUCTION_BUDGET_DEFAULTS };
  try {
    const details = await resolveAdminSettingDetailsMany(
      env,
      BUDGET_KEYS.map((key) => `instructions.${key}` as const)
    );
    BUDGET_KEYS.forEach((key, index) => {
      const value = Number(details[index]?.value);
      if (Number.isFinite(value) && value >= 0) budgets[key] = Math.trunc(value);
    });
  } catch (err) {
    log.warn('mcp.get_instructions.budget_settings_unavailable', {
      error: err instanceof Error ? err.message : String(err),
      action: 'using_defaults',
    });
  }
  return budgets;
}

// ─── Policy relevance ───────────────────────────────────────────────────────

/** Words shorter than this carry too little meaning to decide relevance. */
const MIN_TERM_LENGTH = 4;

/**
 * A term counts toward relevance only if at most this share of the project's applying
 * policies contain it. "agent", "session" or "staging" appear in most SAM policies and in
 * most task descriptions, so matching on them would mark nearly every policy relevant. The
 * share adapts to each project's own vocabulary instead of a hand-kept stop-word list.
 */
const DISTINCTIVE_TERM_MAX_SHARE = 0.2;

const TITLE_TERM_WEIGHT = 2;
const BODY_TERM_WEIGHT = 1;

const CATEGORY_TIER: Record<string, number> = {
  rule: 0,
  constraint: 1,
  delegation: 2,
  preference: 3,
};

export function extractTerms(text: string): Set<string> {
  const terms = new Set<string>();
  for (const word of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (word.length >= MIN_TERM_LENGTH) terms.add(word);
  }
  return terms;
}

export interface BudgetedPolicy extends PolicyEntry {
  injectMode: string;
  updatedAt: number;
}

function distinctiveTerms(policies: BudgetedPolicy[]): (term: string) => boolean {
  const documentFrequency = new Map<string, number>();
  for (const policy of policies) {
    for (const term of extractTerms(`${policy.title} ${policy.content}`)) {
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    }
  }
  const maxFrequency = Math.max(1, Math.floor(policies.length * DISTINCTIVE_TERM_MAX_SHARE));
  return (term) => (documentFrequency.get(term) ?? 0) <= maxFrequency;
}

/** 2 per distinctive title word and 1 per other distinctive body word found in the task text. */
export function scorePolicyRelevance(
  policy: Pick<PolicyEntry, 'title' | 'content'>,
  taskTerms: Set<string>,
  isDistinctive: (term: string) => boolean
): number {
  const titleTerms = extractTerms(policy.title);
  let score = 0;
  for (const term of titleTerms) {
    if (isDistinctive(term) && taskTerms.has(term)) score += TITLE_TERM_WEIGHT;
  }
  for (const term of extractTerms(policy.content)) {
    if (!titleTerms.has(term) && isDistinctive(term) && taskTerms.has(term)) {
      score += BODY_TERM_WEIGHT;
    }
  }
  return score;
}

// ─── Policy selection ───────────────────────────────────────────────────────

export interface PolicySelection {
  /** Policies rendered in full, in the read order (category, created_at). */
  full: BudgetedPolicy[];
  /** On-demand policies listed by title and id only, in the read order. */
  indexed: BudgetedPolicy[];
  pinnedCount: number;
  onDemandCount: number;
  onDemandInFullCount: number;
  onDemandFullChars: number;
}

export function selectPolicies(
  policies: BudgetedPolicy[],
  taskText: string,
  limits: { maxChars: number; maxPerCategory: number; minRelevance: number }
): PolicySelection {
  const onDemand = policies.filter((p) => p.injectMode === 'on_demand');
  const selected = new Set<string>();
  let usedChars = 0;

  if (onDemand.length > 0 && limits.maxChars > 0 && limits.maxPerCategory > 0) {
    const taskTerms = extractTerms(taskText);
    const isDistinctive = distinctiveTerms(policies);
    const ranked = onDemand
      .map((policy) => ({ policy, score: scorePolicyRelevance(policy, taskTerms, isDistinctive) }))
      .filter((r) => r.score >= limits.minRelevance)
      // Most relevant first; ties by force of category, then most recently updated, then id
      // so identical calls always produce identical output (rule 65, requirement 6).
      .sort(
        (a, b) =>
          b.score - a.score ||
          (CATEGORY_TIER[a.policy.category] ?? 9) - (CATEGORY_TIER[b.policy.category] ?? 9) ||
          b.policy.updatedAt - a.policy.updatedAt ||
          (a.policy.id < b.policy.id ? -1 : a.policy.id > b.policy.id ? 1 : 0)
      );
    const perCategory = new Map<string, number>();
    for (const { policy } of ranked) {
      const categoryCount = perCategory.get(policy.category) ?? 0;
      if (categoryCount >= limits.maxPerCategory) continue;
      // +1 for the newline that joins it into the block.
      const lineChars = formatPolicyDirectiveLine(policy).length + 1;
      // A policy is never cut part-way. One that does not fit is listed in the index, and a
      // shorter relevant one further down may still fit.
      if (usedChars + lineChars > limits.maxChars) continue;
      usedChars += lineChars;
      perCategory.set(policy.category, categoryCount + 1);
      selected.add(policy.id);
    }
  }

  const full = policies.filter((p) => p.injectMode !== 'on_demand' || selected.has(p.id));
  const indexed = onDemand.filter((p) => !selected.has(p.id));
  return {
    full,
    indexed,
    pinnedCount: policies.length - onDemand.length,
    onDemandCount: onDemand.length,
    onDemandInFullCount: selected.size,
    onDemandFullChars: usedChars,
  };
}

/** The disclosed index of on-demand policies that were not shown in full. */
export function formatOnDemandPolicyIndex(selection: PolicySelection): string | null {
  if (selection.onDemandCount === 0) return null;
  const heading =
    `### On-demand policies (${selection.onDemandCount}): ` +
    `${selection.onDemandInFullCount} shown in full above because they match this task, ` +
    `${selection.indexed.length} listed here by title only`;
  const lines = [
    heading,
    'These still apply. Before you act in an area one of them covers, call `policies_read` method `get` ' +
      'with its id and follow it. Rules and constraints among them are binding.',
    ...selection.indexed.map((p) => formatPolicyIndexLine(p)),
  ];
  return lines.join('\n');
}

// ─── Knowledge budget ───────────────────────────────────────────────────────

export interface KnowledgeFit {
  directives: string | null;
  shownCount: number;
  droppedForBudget: number;
}

function renderKnowledge(
  shown: KnowledgeEntry[],
  dropped: number,
  entityIndex: KnowledgeEntityIndexEntry[],
  totalEntities: number
): string | null {
  const block = formatKnowledgeDirectives(shown);
  const index = formatKnowledgeEntityIndex(entityIndex, shown, totalEntities, dropped);
  // Without an index (its read failed) the dropped count still has to be disclosed somewhere.
  const orphanNote =
    !index && dropped > 0
      ? `\n${dropped} lower-ranked observations were left out to fit the size budget; ` +
        '`knowledge_read` method `search` reaches them.'
      : null;
  return [block, index, orphanNote].filter((s): s is string => s !== null).join('\n') || null;
}

/**
 * Keep the highest-ranked observations that fit, dropping from the bottom of the ranking
 * (the input order is already confidence x recency, capped per entity). The entity index is
 * always kept, even when it alone exceeds the budget, because it is the disclosure.
 */
export function fitKnowledge(
  ranked: KnowledgeEntry[],
  entityIndex: KnowledgeEntityIndexEntry[],
  totalEntities: number,
  maxChars: number
): KnowledgeFit {
  let shownCount = ranked.length;
  let directives = renderKnowledge(ranked, 0, entityIndex, totalEntities);
  while (shownCount > 0 && directives !== null && directives.length > maxChars) {
    shownCount--;
    directives = renderKnowledge(
      ranked.slice(0, shownCount),
      ranked.length - shownCount,
      entityIndex,
      totalEntities
    );
  }
  return { directives, shownCount, droppedForBudget: ranked.length - shownCount };
}

// ─── Total guard ────────────────────────────────────────────────────────────

export interface InstructionPayloadParts {
  policyDirectives: string | null;
  knowledgeDirectives: string | null;
  /** Extra lines appended to `instructions` (the over-budget note). */
  sizeNotes: string[];
}

export interface BudgetedPayload {
  text: string;
  telemetry: {
    totalChars: number;
    policyChars: number;
    knowledgeChars: number;
    policyCount: number;
    pinnedCount: number;
    onDemandCount: number;
    onDemandInFullCount: number;
    observationCount: number;
    observationsDroppedForBudget: number;
    trimmedForTotal: boolean;
    requiredOverBudget: boolean;
  };
}

export function combinePolicyBlock(full: string | null, onDemandIndex: string | null): string | null {
  if (!onDemandIndex) return full;
  return `${full ?? '## Project Policies — you MUST follow these\n'}\n${onDemandIndex}`;
}

/**
 * Assemble the payload inside the budgets. Order of enforcement:
 *
 * 1. Pinned policies, the task and the other required sections are never trimmed.
 * 2. On-demand policy full text and knowledge are filled within their own budgets.
 * 3. If the serialized text is still over `totalMaxChars`, knowledge is trimmed first, then
 *    on-demand full text, but only when doing so can bring the payload under the total.
 *    When the untrimmable parts alone exceed it, trimming would discard context and still
 *    not fit, so everything is sent, a warning is logged, and one line in `instructions`
 *    says so. Nothing is ever dropped silently: the knowledge and on-demand indexes stay.
 */
export function applyInstructionBudgets(input: {
  projectId: string;
  policies: BudgetedPolicy[];
  knowledge: KnowledgeEntry[];
  entityIndex: KnowledgeEntityIndexEntry[];
  totalEntities: number;
  taskText: string;
  budgets: InstructionBudgets;
  render: (parts: InstructionPayloadParts) => string;
}): BudgetedPayload {
  const { budgets } = input;
  const attempt = (knowledgeMax: number, onDemandMax: number, sizeNotes: string[]) => {
    const selection = selectPolicies(input.policies, input.taskText, {
      maxChars: onDemandMax,
      maxPerCategory: budgets.onDemandPolicyMaxPerCategory,
      minRelevance: budgets.onDemandPolicyMinRelevance,
    });
    const policyDirectives = combinePolicyBlock(
      formatPolicyDirectivesFor(selection.full),
      formatOnDemandPolicyIndex(selection)
    );
    const knowledge = fitKnowledge(
      input.knowledge,
      input.entityIndex,
      input.totalEntities,
      knowledgeMax
    );
    const text = input.render({
      policyDirectives,
      knowledgeDirectives: knowledge.directives,
      sizeNotes,
    });
    return { selection, policyDirectives, knowledge, text };
  };

  let result = attempt(budgets.knowledgeMaxChars, budgets.onDemandPolicyMaxChars, []);
  let trimmedForTotal = false;
  let requiredOverBudget = false;

  if (result.text.length > budgets.totalMaxChars) {
    const floor = attempt(0, 0, []);
    if (floor.text.length > budgets.totalMaxChars) {
      requiredOverBudget = true;
      const pinnedChars = (formatPolicyDirectivesFor(result.selection.full.filter(
        (p) => p.injectMode !== 'on_demand'
      )) ?? '').length;
      const note =
        `Size note: this project's ${result.selection.pinnedCount} pinned policies (${pinnedChars} characters) ` +
        `and the other required sections exceed the instruction size budget (${budgets.totalMaxChars} characters), ` +
        'so they are all sent in full. Nothing was left out.';
      result = attempt(budgets.knowledgeMaxChars, budgets.onDemandPolicyMaxChars, [note]);
      log.warn('mcp.get_instructions.required_over_budget', {
        projectId: input.projectId,
        pinnedCount: result.selection.pinnedCount,
        pinnedChars,
        requiredChars: floor.text.length,
        totalChars: result.text.length,
        budget: budgets.totalMaxChars,
        action: 'sent_in_full',
      });
    } else {
      trimmedForTotal = true;
      const knowledgeChars = result.knowledge.directives?.length ?? 0;
      let over = result.text.length - budgets.totalMaxChars;
      result = attempt(Math.max(0, knowledgeChars - over), budgets.onDemandPolicyMaxChars, []);
      over = result.text.length - budgets.totalMaxChars;
      if (over > 0) {
        result = attempt(0, Math.max(0, result.selection.onDemandFullChars - over), []);
      }
      if (result.text.length > budgets.totalMaxChars) result = floor;
    }
  }

  return {
    text: result.text,
    telemetry: {
      totalChars: result.text.length,
      policyChars: result.policyDirectives?.length ?? 0,
      knowledgeChars: result.knowledge.directives?.length ?? 0,
      policyCount: input.policies.length,
      pinnedCount: result.selection.pinnedCount,
      onDemandCount: result.selection.onDemandCount,
      onDemandInFullCount: result.selection.onDemandInFullCount,
      observationCount: result.knowledge.shownCount,
      observationsDroppedForBudget: result.knowledge.droppedForBudget,
      trimmedForTotal,
      requiredOverBudget,
    },
  };
}
