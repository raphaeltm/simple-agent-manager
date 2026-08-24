/**
 * Formatting helpers for get_instructions policy and knowledge directives.
 *
 * Extracted from instruction-tools.ts to keep it under the 500-line soft /
 * 800-line hard file-size limit (rule 18).
 */

// ─── Policy Formatting Helpers ──────────────────────────────────────────────

export interface PolicyEntry {
  id: string;
  category: string;
  title: string;
  content: string;
  confidence: number;
  scope?: string;
  expiresAt?: number | null;
}

/**
 * Render a policy's shelf life as a short inline annotation.
 *
 * A policy that is going to lapse must not read like a permanent gate, so the
 * agent is told when it expires. Date-only (no time) keeps the annotation to a
 * few tokens — this renders once per policy in every session.
 */
function formatPolicyLifecycle(entry: PolicyEntry): string {
  if (entry.expiresAt === null || entry.expiresAt === undefined) return '';
  const date = new Date(entry.expiresAt).toISOString().slice(0, 10);
  return entry.scope === 'task' ? ` (task-scoped, expires ${date})` : ` (expires ${date})`;
}

/**
 * Format active policies into a readable text block grouped by category.
 * Returns null if there are no policies.
 *
 * Each policy carries its full id inline so agents can call `update_policy` /
 * `remove_policy` without a separate lookup. This is the only place the id is exposed —
 * the former `policyContext` structured array was removed as duplication.
 *
 * Output looks like:
 *   ## Project Policies — you MUST follow these
 *
 *   ### Rules
 *   - **Always use conventional commits** (id: 7d24e435-0153-44a6-a532-1244510d9e25): Commit messages must follow ...
 *
 *   ### Constraints
 *   - **This project uses Valibot, not Zod** (id: 9f1c02ab-77de-4b30-8c11-3ac6d5e81b47): All runtime validation ...
 */
export function formatPolicyDirectives(entries: PolicyEntry[]): string | null {
  if (entries.length === 0) return null;

  // Group by category
  const grouped = new Map<
    string,
    { id: string; title: string; content: string; lifecycle: string }[]
  >();
  for (const entry of entries) {
    let group = grouped.get(entry.category);
    if (!group) {
      group = [];
      grouped.set(entry.category, group);
    }
    group.push({
      id: entry.id,
      title: entry.title,
      content: entry.content,
      lifecycle: formatPolicyLifecycle(entry),
    });
  }

  // Category display order and labels
  const categoryLabels: Record<string, string> = {
    rule: 'Rules (MUST follow)',
    constraint: 'Constraints (technical limitations)',
    delegation: 'Delegation (agent autonomy)',
    preference: 'Preferences (soft guidance)',
  };

  const lines: string[] = ['## Project Policies — you MUST follow these\n'];
  for (const [category, items] of grouped) {
    const label = categoryLabels[category] || category;
    lines.push(`### ${label}`);
    for (const item of items) {
      // The id MUST be rendered in full — `update_policy` / `remove_policy` resolve it with
      // `WHERE id = ?` (exact match), so an abbreviated id would not address the row.
      // The lifecycle annotation sits between the title and the id so a temporary policy
      // reads as temporary at a glance rather than as a permanent gate.
      lines.push(`- **${item.title}**${item.lifecycle} (id: ${item.id}): ${item.content}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Build policy-related instructions based on whether policies exist
 * and the session mode.
 */
export function buildPolicyInstructions(hasPolicies: boolean, isConversation: boolean): string[] {
  const instructions: string[] = [];

  if (hasPolicies) {
    instructions.push(
      'The policyDirectives field above contains project policies set by the user. ' +
        'You MUST follow all rules and constraints. Preferences are softer guidance — follow them unless you have a good reason not to.'
    );
    instructions.push(
      'If a user statement contradicts an existing policy, use `update_policy` to update it. ' +
        'If a policy is no longer relevant, use `remove_policy` to deactivate it. ' +
        'Each policy in policyDirectives is tagged with its `policyId` as "(id: ...)" — pass that id exactly as shown. ' +
        'A policy annotated "(expires ...)" is temporary — treat it as current guidance, not a permanent gate.'
    );
  }

  if (isConversation) {
    instructions.push(
      'When a user states a rule, constraint, delegation preference, or soft preference, ' +
        'save it as a project policy via `add_policy` so it applies to all future agents in this project.'
    );
    instructions.push(
      'Before saving a policy, decide whether it is standing or one-shot. If it is tied to a specific workflow, ' +
        'wave, migration, or dated piece of work — anything that will be finished later — pass `scope: "task"` and an ' +
        '`expiresAt` (epoch ms) to `add_policy` so it stops being injected once that work is done. Only genuinely ' +
        'permanent guidance should be saved with the default `scope: "always"`. Policies without an expiry are loaded ' +
        'into every future session in this project forever, so an un-expiring one-shot policy is a real cost.'
    );
  }

  return instructions;
}
