/**
 * Formatting helpers for get_instructions policy and knowledge directives.
 *
 * Extracted from instruction-tools.ts to keep it under the 500-line soft /
 * 800-line hard file-size limit (rule 18).
 */

import type { KnowledgeEntityIndexEntry } from '../../durable-objects/project-data/knowledge';

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

// ─── Knowledge Formatting Helpers ───────────────────────────────────────────

export interface KnowledgeEntry {
  entityName: string;
  entityType: string;
  observation: string;
  confidence: number;
}

/** Normalize a Promise.allSettled rejection reason for structured logging. */
export function serializeRejection(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

/**
 * Format knowledge observations into a readable text block grouped by entity.
 * Returns null if there are no observations.
 *
 * Output looks like:
 *   ## Project Knowledge — apply these to your work
 *
 *   **User** (context): Raphaël, solo founder. Primarily uses mobile PWA.
 *   **CodeQuality** (preference): Prefers Valibot. Skeptical of useEffect.
 */
export function formatKnowledgeDirectives(entries: KnowledgeEntry[]): string | null {
  if (entries.length === 0) return null;

  // Group by entity name
  const grouped = new Map<string, { entityType: string; observations: string[] }>();
  for (const entry of entries) {
    let group = grouped.get(entry.entityName);
    if (!group) {
      group = { entityType: entry.entityType, observations: [] };
      grouped.set(entry.entityName, group);
    }
    group.observations.push(entry.observation);
  }

  const lines: string[] = ['## Project Knowledge — apply these to your work\n'];
  for (const [name, group] of grouped) {
    const obs = group.observations.join(' | ');
    lines.push(`**${name}** (${group.entityType}): ${obs}`);
  }

  return lines.join('\n');
}

/**
 * Render the complete entity index that accompanies the ranked directives.
 *
 * The directive block is ranked and capped, so it is deliberately partial. Without
 * this index that truncation is invisible — an agent cannot search for a topic it has
 * no reason to believe exists, which is precisely how ContentStyle/User/Architecture
 * stayed unreachable for months. One short line per entity keeps the whole store
 * discoverable for roughly a token apiece.
 */
export function formatKnowledgeEntityIndex(
  entityIndex: KnowledgeEntityIndexEntry[],
  injected: KnowledgeEntry[],
  totalEntities: number
): string | null {
  if (entityIndex.length === 0) return null;

  const injectedEntities = new Set(injected.map((e) => e.entityName));
  const notInjected = entityIndex.filter((e) => !injectedEntities.has(e.name)).length;

  // The index itself is capped, and a project may hold more entities than that cap.
  // Claiming "full" while truncating would repeat this bug one level up, so the header
  // only says "Full" when it genuinely is, and otherwise states N of M.
  const truncated = totalEntities > entityIndex.length;
  const heading = truncated
    ? `### Knowledge index (${entityIndex.length} of ${totalEntities} entities, densest first)`
    : `### Full knowledge index (${entityIndex.length} entities)`;

  return [
    `\n${heading}\n` +
      'The block above shows only the highest-ranked observations, capped per entity — it is NOT everything ' +
      `this project knows.${notInjected > 0 ? ` ${notInjected} of the entities listed here have no observations shown above at all.` : ''} ` +
      `${truncated ? `A further ${totalEntities - entityIndex.length} entities are not listed; \`search_knowledge\` still reaches them. ` : ''}` +
      'Each entry below is `EntityName (type, N observations)`. To read anything not shown in full, call ' +
      '`search_knowledge` with the entity name, or `get_relevant_knowledge` with a description of what you are about to do. ' +
      'Do this before decisions that touch one of these topics.\n',
    entityIndex.map((e) => `${e.name} (${e.entityType}, ${e.observationCount})`).join(', '),
  ].join('\n');
}

/**
 * Build knowledge graph instructions based on whether knowledge exists
 * and the session mode. Conversation mode gets more aggressive capture
 * instructions since direct user interaction is the richest source.
 */
export function buildKnowledgeInstructions(
  hasKnowledge: boolean,
  isConversation: boolean
): string[] {
  const instructions: string[] = [];

  // Core directive — MUST, not "you can"
  instructions.push(
    'You MUST use the knowledge graph to remember important facts about the user and project across sessions.'
  );

  // When to SAVE — concrete trigger patterns
  instructions.push(
    'Save to knowledge graph (via `add_knowledge`) when ANY of these happen: ' +
      '(1) User corrects you or says "don\'t do X" → sourceType "explicit", confidence 0.9+. ' +
      '(2) User states a preference ("I prefer...", "always use...", "never...") → sourceType "explicit", confidence 0.9+. ' +
      '(3) User describes their role, expertise, or background → entityType "expertise". ' +
      '(4) You learn a project convention or architecture decision → entityType "context". ' +
      '(5) User gives feedback on your response style → entityType "preference".'
  );

  // When to READ — decision-point retrieval (Layer 2)
  instructions.push(
    'Search knowledge (via `search_knowledge`) BEFORE making key decisions: ' +
      'before writing content/blogs → search "ContentStyle"; ' +
      'before choosing libraries/tools → search "CodeQuality"; ' +
      'before UI layout decisions → search "User" and "mobile"; ' +
      'before architecture decisions → search "Architecture"; ' +
      'before pricing/business decisions → search "BusinessStrategy". ' +
      'These entities are usually NOT injected in full — check the knowledge index for what exists, ' +
      'then retrieve it. Do not assume an entity is empty because its observations are not shown above.'
  );

  // What NOT to save
  instructions.push(
    'Do NOT save to knowledge: code patterns derivable from the codebase, git history, ephemeral task details, or things already in CLAUDE.md or project config.'
  );

  if (hasKnowledge) {
    // Knowledge exists — tell agent to apply it and maintain it
    instructions.push(
      'The knowledgeDirectives field above contains stored knowledge from previous sessions. Apply these preferences and facts to your work. ' +
        'It is RANKED (by confidence and how recently each observation was confirmed) and CAPPED per entity, so it is a partial view, not the whole store. ' +
        'Its trailing knowledge-index section lists entities with their observation counts, and states in its own heading whether that list is itself complete or truncated — do not infer completeness from this sentence. ' +
        'Use `search_knowledge` or `get_relevant_knowledge` to pull anything listed there but not shown in full, and to reach entities the index itself had to drop. ' +
        'If any observation seems outdated, call `update_knowledge` or `remove_knowledge`. ' +
        'If you verify an observation is still accurate, call `confirm_knowledge` to keep it fresh — confirming also raises its rank for future sessions.'
    );
  } else {
    // Empty knowledge graph — bootstrapping prompt
    instructions.push(
      'This project has no stored knowledge yet. ' +
        'Actively look for user preferences, project conventions, and important context to store. ' +
        'If this is a conversation, ask the user about their preferences when relevant. ' +
        'You can also search past conversations (via `search_messages`) for user preferences using queries like "prefer", "don\'t want", "I like", "always" to seed the knowledge graph.'
    );
  }

  if (isConversation) {
    instructions.push(
      'You are in a direct conversation — this is the richest source of user knowledge. ' +
        'Pay close attention to corrections, preferences, and context the user shares. ' +
        'Store important observations as you go, not just at the end.'
    );
  }

  return instructions;
}
