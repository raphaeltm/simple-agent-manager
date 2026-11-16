/**
 * Pure selection and budget logic for get_instructions (instruction-budget.ts).
 * The end-to-end path through the real Worker and ProjectData DO is in
 * tests/workers/get-instructions-budget.test.ts.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../../src/services/admin-settings', () => ({
  resolveAdminSettingDetailsMany: vi.fn(),
}));

import {
  applyInstructionBudgets,
  type BudgetedPolicy,
  fitKnowledge,
  formatOnDemandPolicyIndex,
  selectPolicies,
} from '../../../../src/routes/mcp/instruction-budget';
import {
  formatKnowledgeDirectives,
  formatKnowledgeEntityIndex,
  formatPolicyDirectives,
  type KnowledgeEntry,
} from '../../../../src/routes/mcp/instruction-formatting';
import { INSTRUCTION_BUDGET_DEFAULTS } from '../../../../src/services/admin-settings-instructions-definitions';

let seq = 0;
function policy(overrides: Partial<BudgetedPolicy> = {}): BudgetedPolicy {
  seq++;
  return {
    id: `pol-${String(seq).padStart(4, '0')}`,
    category: 'preference',
    title: `Generic preference number ${seq}`,
    content: 'Agents should keep their work tidy and report progress clearly.',
    confidence: 0.9,
    scope: 'always',
    expiresAt: null,
    injectMode: 'pinned',
    updatedAt: 1_000 + seq,
    ...overrides,
  };
}

const LIMITS = { maxChars: 100_000, maxPerCategory: 50, minRelevance: 2 };

function idsInText(text: string, ids: string[]): Record<string, number> {
  return Object.fromEntries(ids.map((id) => [id, text.split(id).length - 1]));
}

describe('selectPolicies', () => {
  it('renders every pinned policy in full and adds no index', () => {
    const policies = [policy({ category: 'rule' }), policy(), policy({ category: 'constraint' })];
    const selection = selectPolicies(policies, 'anything at all', LIMITS);
    expect(selection.full).toEqual(policies);
    expect(selection.indexed).toEqual([]);
    expect(formatOnDemandPolicyIndex(selection)).toBeNull();
  });

  it('ranks by relevance, not age: one old strong match beats newer weak matches (rule 65 skew)', () => {
    const match = policy({
      title: 'Wrangler bindings belong at the top level',
      content: 'Generated environment sections copy them.',
      injectMode: 'on_demand',
      updatedAt: 1,
    });
    // Newer, and each weakly relevant (one body word), so recency ordering would pick them.
    const crowd = Array.from({ length: 15 }, () =>
      policy({ content: 'Mention the binding once.', injectMode: 'on_demand' })
    );
    const unrelated = Array.from({ length: 85 }, () => policy());
    const policies = [match, ...crowd, ...unrelated];
    const selection = selectPolicies(
      policies,
      'Add a new Durable Object binding to wrangler.toml at the top level',
      // Room for exactly one policy line.
      { maxChars: 160, maxPerCategory: 50, minRelevance: 1 }
    );
    expect(selection.full.filter((p) => p.injectMode === 'on_demand').map((p) => p.id)).toEqual([
      match.id,
    ]);
    expect(selection.indexed).toHaveLength(15);
    expect(selection.onDemandInFullCount).toBe(1);
  });

  it('does not show a policy in full when nothing distinctive matches the task', () => {
    const unrelated = policy({ title: 'Daily journal stays technical', injectMode: 'on_demand' });
    const selection = selectPolicies([unrelated, policy()], 'Fix the node cleanup sweep', LIMITS);
    expect(selection.indexed.map((p) => p.id)).toEqual([unrelated.id]);
  });

  it('ignores words most policies share, so they cannot make everything relevant', () => {
    // "staging" is in 9 of 10 policies: above the distinctive share, so it scores nothing.
    const policies = Array.from({ length: 10 }, (_, i) =>
      policy({
        title: i === 9 ? 'Unrelated title words' : `Staging rule variant ${i}`,
        content: i === 9 ? 'Nothing shared.' : 'Use staging carefully.',
        injectMode: 'on_demand',
      })
    );
    const selection = selectPolicies(policies, 'Deploy to staging', LIMITS);
    expect(selection.onDemandInFullCount).toBe(0);
  });

  it('caps one category so preferences cannot take every slot, and frees slots for others', () => {
    const prefs = Array.from({ length: 8 }, (_, i) =>
      policy({ title: `Tunnel preference ${i}`, injectMode: 'on_demand' })
    );
    const rules = Array.from({ length: 2 }, (_, i) =>
      policy({ category: 'rule', title: `Tunnel rule ${i}`, injectMode: 'on_demand' })
    );
    // 20 unrelated pinned policies keep "tunnel" distinctive.
    const pinned = Array.from({ length: 40 }, () => policy());
    const all = [...prefs, ...rules, ...pinned];
    const capped = selectPolicies(all, 'cloudflare tunnel work', { ...LIMITS, maxPerCategory: 3 });
    const shown = capped.full.filter((p) => p.injectMode === 'on_demand');
    expect(shown.filter((p) => p.category === 'preference')).toHaveLength(3);
    expect(shown.filter((p) => p.category === 'rule')).toHaveLength(2);
    // Control: the cap, not the data, is what limited preferences.
    const raised = selectPolicies(all, 'cloudflare tunnel work', { ...LIMITS, maxPerCategory: 10 });
    expect(
      raised.full.filter((p) => p.injectMode === 'on_demand' && p.category === 'preference')
    ).toHaveLength(8);
  });

  it('never cuts a policy part-way: one that does not fit is indexed and a shorter one can still fit', () => {
    const long = policy({
      title: 'Tunnel long',
      content: 'x'.repeat(500),
      injectMode: 'on_demand',
    });
    const short = policy({ title: 'Tunnel short', content: 'y', injectMode: 'on_demand' });
    const filler = Array.from({ length: 20 }, () => policy());
    const selection = selectPolicies([long, short, ...filler], 'tunnel', {
      ...LIMITS,
      maxChars: 200,
    });
    expect(selection.full.map((p) => p.id)).toContain(short.id);
    expect(selection.indexed.map((p) => p.id)).toEqual([long.id]);
    const block = formatPolicyDirectives(selection.full) ?? '';
    expect(block).not.toContain('x'.repeat(50));
  });

  it('is deterministic for ties', () => {
    const policies = Array.from({ length: 12 }, (_, i) =>
      policy({ title: `Tunnel tie ${i}`, injectMode: 'on_demand', updatedAt: 5 })
    ).concat(Array.from({ length: 50 }, () => policy()));
    const a = selectPolicies(policies, 'tunnel', { ...LIMITS, maxPerCategory: 4 });
    const b = selectPolicies([...policies].reverse(), 'tunnel', { ...LIMITS, maxPerCategory: 4 });
    expect(
      a.full
        .filter((p) => p.injectMode === 'on_demand')
        .map((p) => p.id)
        .sort()
    ).toEqual(
      b.full
        .filter((p) => p.injectMode === 'on_demand')
        .map((p) => p.id)
        .sort()
    );
  });

  it('discloses counts and the fetch tool in the index, with every on-demand id exactly once', () => {
    const shown = policy({ title: 'Tunnel shown', category: 'rule', injectMode: 'on_demand' });
    const hidden = policy({ title: 'Journal hidden', category: 'rule', injectMode: 'on_demand' });
    const policies = [shown, hidden, ...Array.from({ length: 20 }, () => policy())];
    const selection = selectPolicies(policies, 'tunnel', LIMITS);
    const index = formatOnDemandPolicyIndex(selection) ?? '';
    expect(index).toContain(
      '### On-demand policies (2): 1 shown in full above because they match this task, 1 listed here by title only'
    );
    expect(index).toContain('`policies_read` method `get`');
    const text = `${formatPolicyDirectives(selection.full)}\n${index}`;
    expect(
      idsInText(
        text,
        policies.map((p) => p.id)
      )
    ).toEqual(Object.fromEntries(policies.map((p) => [p.id, 1])));
  });
});

describe('fitKnowledge', () => {
  const entries: KnowledgeEntry[] = Array.from({ length: 10 }, (_, i) => ({
    entityName: `Entity${i % 3}`,
    entityType: 'context',
    observation: `Observation ${i} ${'detail '.repeat(30)}`,
    confidence: 0.9,
  }));
  const index = [0, 1, 2].map((i) => ({
    name: `Entity${i}`,
    entityType: 'context',
    observationCount: 5,
  }));

  it('is identical to the unbudgeted rendering when everything fits', () => {
    const fit = fitKnowledge(entries, index, 3, 1_000_000);
    const unbudgeted = [
      formatKnowledgeDirectives(entries),
      formatKnowledgeEntityIndex(index, entries, 3),
    ].join('\n');
    expect(fit.directives).toBe(unbudgeted);
    expect(fit.droppedForBudget).toBe(0);
  });

  it('drops the lowest-ranked observations first, keeps the index, and says how many were dropped', () => {
    const fit = fitKnowledge(entries, index, 3, 1_500);
    expect(fit.directives!.length).toBeLessThanOrEqual(1_500);
    expect(fit.droppedForBudget).toBeGreaterThan(0);
    expect(fit.shownCount).toBe(10 - fit.droppedForBudget);
    // The kept ones are the top of the ranking.
    for (let i = 0; i < fit.shownCount; i++) expect(fit.directives).toContain(`Observation ${i} `);
    expect(fit.directives).not.toContain(`Observation 9 `);
    expect(fit.directives).toContain('knowledge index');
    expect(fit.directives).toContain(
      `${fit.droppedForBudget} lower-ranked observations were left out`
    );
  });

  it('keeps the index even when it alone exceeds the budget', () => {
    const fit = fitKnowledge(entries, index, 3, 10);
    expect(fit.shownCount).toBe(0);
    expect(fit.directives).toContain('Entity0 (context, 5)');
  });

  it('discloses dropped observations even when the index read failed', () => {
    const fit = fitKnowledge(entries, [], 0, 400);
    expect(fit.directives).toContain(
      'lower-ranked observations were left out to fit the size budget'
    );
  });
});

describe('applyInstructionBudgets', () => {
  const pinned = Array.from({ length: 30 }, () =>
    policy({ category: 'rule', content: 'z'.repeat(400) })
  );
  const knowledge: KnowledgeEntry[] = Array.from({ length: 20 }, (_, i) => ({
    entityName: `E${i}`,
    entityType: 'context',
    observation: `obs ${i} ${'k'.repeat(300)}`,
    confidence: 0.9,
  }));
  const render = (parts: {
    policyDirectives: string | null;
    knowledgeDirectives: string | null;
    sizeNotes: string[];
  }) => JSON.stringify({ instructions: ['fixed', ...parts.sizeNotes], ...parts }, null, 2);
  const base = {
    projectId: 'p',
    knowledge,
    entityIndex: [],
    totalEntities: 0,
    taskText: 'task',
    render,
  };

  it('sends pinned policies in full with a size note when they alone exceed the total', () => {
    const out = applyInstructionBudgets({
      ...base,
      policies: pinned,
      budgets: { ...INSTRUCTION_BUDGET_DEFAULTS, totalMaxChars: 5_000 },
    });
    expect(out.telemetry.requiredOverBudget).toBe(true);
    for (const p of pinned) expect(out.text).toContain(p.id);
    expect(out.text).toContain('pinned policies');
    expect(out.text).toContain('Nothing was left out.');
    // Trimming knowledge could not have reached the budget, so it was not trimmed.
    expect(out.telemetry.observationsDroppedForBudget).toBe(0);
  });

  it('trims knowledge to reach the total when that is enough, and adds no note', () => {
    const out = applyInstructionBudgets({
      ...base,
      policies: pinned.slice(0, 3),
      budgets: { ...INSTRUCTION_BUDGET_DEFAULTS, totalMaxChars: 4_000 },
    });
    expect(out.text.length).toBeLessThanOrEqual(4_000);
    expect(out.telemetry.trimmedForTotal).toBe(true);
    expect(out.telemetry.observationsDroppedForBudget).toBeGreaterThan(0);
    expect(out.text).not.toContain('Size note');
    for (const p of pinned.slice(0, 3)) expect(out.text).toContain(p.id);
  });

  it('leaves the payload alone when it is under every budget', () => {
    const budgets = {
      ...INSTRUCTION_BUDGET_DEFAULTS,
      totalMaxChars: 2_000_000,
      knowledgeMaxChars: 2_000_000,
    };
    const out = applyInstructionBudgets({ ...base, policies: pinned, budgets });
    expect(out.text).toBe(
      render({
        policyDirectives: formatPolicyDirectives(pinned),
        knowledgeDirectives: formatKnowledgeDirectives(knowledge),
        sizeNotes: [],
      })
    );
  });
});
