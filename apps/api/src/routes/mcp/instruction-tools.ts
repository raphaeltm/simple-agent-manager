/**
 * MCP instruction tools — get_instructions and request_human_input.
 */
import type { HumanInputCategory } from '@simple-agent-manager/shared';
import {
  HUMAN_INPUT_CATEGORIES,
  KNOWLEDGE_DEFAULTS,
  MAX_HUMAN_INPUT_CONTEXT_LENGTH,
  MAX_HUMAN_INPUT_OPTION_LENGTH,
  MAX_HUMAN_INPUT_OPTIONS_COUNT,
} from '@simple-agent-manager/shared';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../../db/schema';
import { computeHumanInputSchedule } from '../../durable-objects/project-data/attention';
import type { KnowledgeEntityIndexEntry } from '../../durable-objects/project-data/knowledge';
import type { Env } from '../../env';
import { log } from '../../lib/logger';
import * as notificationService from '../../services/notification';
import * as projectDataService from '../../services/project-data';
import {
  INTERNAL_ERROR,
  INVALID_PARAMS,
  jsonRpcError,
  type JsonRpcResponse,
  jsonRpcSuccess,
  type McpTokenData,
  sanitizeUserInput,
} from './_helpers';

type InstructionContextType = 'task' | 'conversation' | 'trial' | 'direct-workspace';

interface ResolvedInstructionContext {
  type: InstructionContextType;
  task?: schema.Task;
  session?: Record<string, unknown> | null;
  chatSessionId?: string | null;
  workspaceId?: string | null;
  agentSessionId?: string | null;
}

function inferInstructionContextType(tokenData: McpTokenData): InstructionContextType {
  if (tokenData.contextType) return tokenData.contextType;
  if (tokenData.taskId) return 'task';
  if (tokenData.chatSessionId) return 'conversation';
  return 'direct-workspace';
}

export async function resolveInstructionContext(
  tokenData: McpTokenData,
  env: Env
): Promise<{ ok: true; context: ResolvedInstructionContext } | { ok: false; message: string }> {
  const contextType = inferInstructionContextType(tokenData);

  if (contextType === 'task') {
    if (!tokenData.taskId) {
      return { ok: false, message: 'Task context missing taskId' };
    }
    const db = drizzle(env.DATABASE, { schema });
    const taskRows = await db
      .select()
      .from(schema.tasks)
      .where(
        and(eq(schema.tasks.id, tokenData.taskId), eq(schema.tasks.projectId, tokenData.projectId))
      )
      .limit(1);

    const task = taskRows[0];
    if (!task) {
      return { ok: false, message: 'Task not found' };
    }
    return { ok: true, context: { type: 'task', task } };
  }

  if (!tokenData.projectId || !tokenData.workspaceId) {
    return { ok: false, message: 'Instruction context missing projectId or workspaceId' };
  }

  if (contextType === 'conversation' && !tokenData.chatSessionId) {
    return { ok: false, message: 'Conversation context missing chatSessionId' };
  }

  const session = tokenData.chatSessionId
    ? await projectDataService
        .getSession(env, tokenData.projectId, tokenData.chatSessionId)
        .catch(() => null)
    : null;

  if (contextType === 'conversation' && !session) {
    return { ok: false, message: 'Conversation session not found' };
  }

  return {
    ok: true,
    context: {
      type: contextType,
      session,
      chatSessionId: tokenData.chatSessionId ?? null,
      workspaceId: tokenData.workspaceId,
      agentSessionId: tokenData.agentSessionId ?? null,
    },
  };
}

export async function handleGetInstructions(
  requestId: string | number | null,
  tokenData: McpTokenData,
  env: Env
): Promise<JsonRpcResponse> {
  const db = drizzle(env.DATABASE, { schema });

  const resolved = await resolveInstructionContext(tokenData, env);
  if (!resolved.ok) {
    return jsonRpcError(requestId, INTERNAL_ERROR, resolved.message);
  }
  const { context } = resolved;

  // Fetch project
  const projectRows = await db
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.id, tokenData.projectId))
    .limit(1);

  const project = projectRows[0];
  if (!project) {
    return jsonRpcError(requestId, INTERNAL_ERROR, 'Project not found');
  }

  // Auto-retrieve high-confidence knowledge for this project.
  // Keyword-matching against the task title misses most relevant knowledge, so instead
  // of guessing from the title we take everything above a confidence bar and rank it by
  // relevance (confidence x recency of last confirmation), capped per entity. The cap
  // matters: injection used to be ordered alphabetically by entity name, so in practice
  // one grab-bag entity consumed 46 of 50 slots and entities the agent is explicitly
  // told to consult never appeared. Whatever does not fit is still discoverable via the
  // entity index appended below.
  const minConfidence =
    parseFloat(env.KNOWLEDGE_AUTO_RETRIEVE_MIN_CONFIDENCE || '') ||
    KNOWLEDGE_DEFAULTS.autoRetrieveMinConfidence;
  const highConfidenceLimit =
    parseInt(env.KNOWLEDGE_AUTO_RETRIEVE_HIGH_CONFIDENCE_LIMIT || '', 10) ||
    KNOWLEDGE_DEFAULTS.autoRetrieveHighConfidenceLimit;
  const perEntityLimit =
    parseInt(env.KNOWLEDGE_AUTO_RETRIEVE_PER_ENTITY_LIMIT || '', 10) ||
    KNOWLEDGE_DEFAULTS.autoRetrievePerEntityLimit;
  const entityIndexLimit =
    parseInt(env.KNOWLEDGE_ENTITY_INDEX_LIMIT || '', 10) || KNOWLEDGE_DEFAULTS.entityIndexLimit;
  let knowledgeContext: {
    entityName: string;
    entityType: string;
    observation: string;
    confidence: number;
  }[] = [];
  // Retrieve active project policies (Phase 4: Policy Propagation).
  // Policies are dynamic rules and preferences that agents must follow.
  let policyContext: {
    id: string;
    category: string;
    title: string;
    content: string;
    confidence: number;
  }[] = [];
  let entityIndex: KnowledgeEntityIndexEntry[] = [];
  let totalEntities = 0;

  // These three reads all target the same ProjectData DO and none depends on another's
  // result, so they run concurrently rather than as three serial round-trips on a path
  // that executes at every session start (rule 60).
  //
  // Each is isolated: a failure degrades only its own slice. That matters most for the
  // entity index, which is what tells the agent the injected set is partial — if ranked
  // retrieval dies, the index alone still says what exists and how to fetch it, instead
  // of the pre-existing behaviour of silently injecting nothing at all.
  const [knowledgeResult, entityIndexResult, policyResult] = await Promise.allSettled([
    projectDataService.getAllHighConfidenceKnowledge(
      env,
      tokenData.projectId,
      minConfidence,
      highConfidenceLimit,
      perEntityLimit
    ),
    projectDataService.getKnowledgeEntityIndex(env, tokenData.projectId, entityIndexLimit),
    projectDataService.getActivePolicies(env, tokenData.projectId),
  ]);

  // Each slice is shape-checked, not just status-checked. `allSettled` only reports
  // whether the RPC threw; a fulfilled-but-malformed value (an older DO revision mid-deploy,
  // a shape change) would otherwise throw HERE, outside any try/catch, and 500 the entire
  // get_instructions call — taking session bootstrap down with it. A degraded knowledge
  // slice must cost only that slice.
  if (knowledgeResult.status === 'fulfilled' && Array.isArray(knowledgeResult.value)) {
    knowledgeContext = knowledgeResult.value.map((r) => ({
      entityName: r.entityName,
      entityType: r.entityType,
      observation: r.content,
      confidence: r.confidence,
    }));
  } else {
    log.warn('mcp.get_instructions.knowledge_retrieval_failed', {
      projectId: tokenData.projectId,
      error:
        knowledgeResult.status === 'rejected'
          ? serializeRejection(knowledgeResult.reason)
          : 'malformed_result',
    });
  }

  if (entityIndexResult.status === 'fulfilled' && Array.isArray(entityIndexResult.value?.entries)) {
    entityIndex = entityIndexResult.value.entries;
    totalEntities =
      typeof entityIndexResult.value.totalEntities === 'number'
        ? entityIndexResult.value.totalEntities
        : entityIndex.length;
  } else {
    log.warn('mcp.get_instructions.knowledge_entity_index_failed', {
      projectId: tokenData.projectId,
      error:
        entityIndexResult.status === 'rejected'
          ? serializeRejection(entityIndexResult.reason)
          : 'malformed_result',
    });
  }

  if (policyResult.status === 'fulfilled' && Array.isArray(policyResult.value)) {
    policyContext = policyResult.value.map((p) => ({
      id: p.id,
      category: p.category,
      title: p.title,
      content: p.content,
      confidence: p.confidence,
    }));
  } else {
    log.warn('mcp.get_instructions.policy_retrieval_failed', {
      projectId: tokenData.projectId,
      error:
        policyResult.status === 'rejected'
          ? serializeRejection(policyResult.reason)
          : 'malformed_result',
    });
  }

  // Format knowledge as actionable directives grouped by entity, not raw JSON.
  // Agents are more likely to apply knowledge when it reads like instructions.
  const knowledgeDirectives =
    [
      formatKnowledgeDirectives(knowledgeContext),
      formatKnowledgeEntityIndex(entityIndex, knowledgeContext, totalEntities),
    ]
      .filter((section): section is string => section !== null)
      .join('\n') || null;

  // Build knowledge-related instructions based on whether knowledge exists.
  // A project with entities but nothing above the confidence bar still has knowledge —
  // it is reachable by search — so it must not get the "no stored knowledge" bootstrap text.
  const knowledgeInstructions = buildKnowledgeInstructions(
    knowledgeContext.length > 0 || entityIndex.length > 0,
    context.type === 'conversation' || context.task?.taskMode === 'conversation'
  );

  const policyDirectives = formatPolicyDirectives(policyContext);
  const policyInstructions = buildPolicyInstructions(
    policyContext.length > 0,
    context.type === 'conversation' || context.task?.taskMode === 'conversation'
  );

  const isConversation =
    context.type === 'conversation' || context.task?.taskMode === 'conversation';

  const result = {
    context: {
      type: context.type,
      chatSessionId: context.chatSessionId ?? undefined,
      workspaceId: context.workspaceId ?? tokenData.workspaceId,
      agentSessionId: context.agentSessionId ?? tokenData.agentSessionId,
    },
    ...(context.task
      ? {
          task: {
            id: context.task.id,
            title: context.task.title,
            description: context.task.description,
            status: context.task.status,
            priority: context.task.priority,
            outputBranch: context.task.outputBranch,
          },
        }
      : {}),
    ...(context.session
      ? {
          session: {
            id: context.chatSessionId,
            topic: typeof context.session.topic === 'string' ? context.session.topic : null,
          },
        }
      : {}),
    project: {
      id: project.id,
      name: project.name,
      repository: project.repository,
      defaultBranch: project.defaultBranch,
      repoProvider: project.repoProvider || 'github',
    },
    instructions: [
      'Tool names in these instructions refer to SAM MCP tools from the `sam-mcp` MCP server.',
      'After reading this response, check whether the current chat session topic/title accurately reflects the actual work. ' +
        'If the title is stale, generic, copied from a fork such as "get details from previous session", or the session changes direction later, ' +
        'call the SAM MCP `update_session_topic` tool with a concise descriptive topic.',
      ...(isConversation
        ? [
            'You are in a conversation with a human. Respond to their messages directly.',
            'Use the SAM MCP `dispatch_task` tool to spawn follow-up work to other agents when needed.',
            'Use the SAM MCP `update_task_status` tool to report significant findings or progress.',
            'Do NOT call the SAM MCP `complete_task` tool — the human will end the conversation when they are ready.',
            'If you encounter blockers, report them via the SAM MCP `update_task_status` tool with a clear description.',
          ]
        : [
            'Call the SAM MCP `update_task_status` tool to report progress as you complete significant milestones.',
            'Call the SAM MCP `complete_task` tool with a summary when all work is done.',
            'Push your changes to the output branch before calling the SAM MCP `complete_task` tool.',
            'If you encounter blockers, report them via the SAM MCP `update_task_status` tool with a clear description.',
          ]),
      ...knowledgeInstructions,
      ...policyInstructions,
      ...(project.repoProvider === 'artifacts'
        ? [
            'This project uses SAM Git (Cloudflare Artifacts) — NOT GitHub.',
            'Do NOT use `gh pr create`, `gh` CLI, or any GitHub-specific commands.',
            'Push your changes directly to the remote branch. Summarize your changes in the task completion message.',
          ]
        : []),
      ...(project.repoProvider === 'gitlab'
        ? [
            'This project uses GitLab — NOT GitHub.',
            'Do NOT use `gh pr create`, `gh` CLI, or any GitHub-specific commands.',
            'Push your changes to the remote branch. SAM will create a GitLab merge request from the workspace completion path when applicable.',
          ]
        : []),
    ],
    // Formatted directives are the SINGLE representation of knowledge and policies.
    //
    // These used to be accompanied by `knowledgeContext` / `policyContext` structured
    // arrays "for programmatic use", but nothing ever consumed them and every observation
    // and policy body was therefore serialized twice — ~86K chars (~21k tokens) of pure
    // duplication on every session bootstrap. Policy IDs (needed by `update_policy` /
    // `remove_policy`) lived only in the structured array, so they are now rendered inline
    // by formatPolicyDirectives instead. See the R1 token-optimization task.
    //
    // The policy id is deliberately conveyed in prose while every other id here
    // (`context.task.id`, `project.id`, `context.workspaceId`) is a structured field. Do
    // NOT "fix" that by re-adding a `policyIds` array: the only consumer of this payload is
    // the LLM, for which prose and JSON are equally parseable; a bare id array would need
    // its titles re-duplicated to be correlatable, costing ~2x the inline form; and callers
    // that need structured policy data already have `list_policies` / `get_policy`.
    ...(knowledgeDirectives ? { knowledgeDirectives } : {}),
    ...(policyDirectives ? { policyDirectives } : {}),
  };

  return jsonRpcSuccess(requestId, {
    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
  });
}

// ─── Knowledge Formatting Helpers ───────────────────────────────────────────

interface KnowledgeEntry {
  entityName: string;
  entityType: string;
  observation: string;
  confidence: number;
}

/** Normalize a Promise.allSettled rejection reason for structured logging. */
function serializeRejection(reason: unknown): string {
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
function formatKnowledgeDirectives(entries: KnowledgeEntry[]): string | null {
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
function formatKnowledgeEntityIndex(
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
function buildKnowledgeInstructions(hasKnowledge: boolean, isConversation: boolean): string[] {
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

// ─── Policy Formatting Helpers ──────────────────────────────────────────────

interface PolicyEntry {
  id: string;
  category: string;
  title: string;
  content: string;
  confidence: number;
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
function formatPolicyDirectives(entries: PolicyEntry[]): string | null {
  if (entries.length === 0) return null;

  // Group by category
  const grouped = new Map<string, { id: string; title: string; content: string }[]>();
  for (const entry of entries) {
    let group = grouped.get(entry.category);
    if (!group) {
      group = [];
      grouped.set(entry.category, group);
    }
    group.push({ id: entry.id, title: entry.title, content: entry.content });
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
      lines.push(`- **${item.title}** (id: ${item.id}): ${item.content}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Build policy-related instructions based on whether policies exist
 * and the session mode.
 */
function buildPolicyInstructions(hasPolicies: boolean, isConversation: boolean): string[] {
  const instructions: string[] = [];

  if (hasPolicies) {
    instructions.push(
      'The policyDirectives field above contains project policies set by the user. ' +
        'You MUST follow all rules and constraints. Preferences are softer guidance — follow them unless you have a good reason not to.'
    );
    instructions.push(
      'If a user statement contradicts an existing policy, use `update_policy` to update it. ' +
        'If a policy is no longer relevant, use `remove_policy` to deactivate it. ' +
        'Each policy in policyDirectives is tagged with its `policyId` as "(id: ...)" — pass that id exactly as shown.'
    );
  }

  if (isConversation) {
    instructions.push(
      'When a user states a rule, constraint, delegation preference, or soft preference, ' +
        'save it as a project policy via `add_policy` so it applies to all future agents in this project.'
    );
  }

  return instructions;
}

export async function handleRequestHumanInput(
  requestId: string | number | null,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env
): Promise<JsonRpcResponse> {
  const context = params.context;
  if (typeof context !== 'string' || !context.trim()) {
    return jsonRpcError(
      requestId,
      INVALID_PARAMS,
      'context is required and must be a non-empty string'
    );
  }

  if (context.length > MAX_HUMAN_INPUT_CONTEXT_LENGTH) {
    return jsonRpcError(
      requestId,
      INVALID_PARAMS,
      `context exceeds maximum length of ${MAX_HUMAN_INPUT_CONTEXT_LENGTH} characters`
    );
  }

  // Sanitize context: strip null bytes, Unicode bidi overrides, and C0/C1 control chars (except \n, \t)
  const sanitizedContext = sanitizeUserInput(context.trim());

  // Validate category if provided
  let category: HumanInputCategory | null = null;
  if (params.category !== undefined) {
    if (
      typeof params.category !== 'string' ||
      !(HUMAN_INPUT_CATEGORIES as readonly string[]).includes(params.category)
    ) {
      return jsonRpcError(
        requestId,
        INVALID_PARAMS,
        `category must be one of: ${HUMAN_INPUT_CATEGORIES.join(', ')}`
      );
    }
    category = params.category as HumanInputCategory;
  }

  // Validate options if provided
  let options: string[] | null = null;
  if (params.options !== undefined) {
    if (!Array.isArray(params.options)) {
      return jsonRpcError(requestId, INVALID_PARAMS, 'options must be an array of strings');
    }
    if (params.options.some((o: unknown) => typeof o !== 'string')) {
      return jsonRpcError(requestId, INVALID_PARAMS, 'options must contain only strings');
    }
    options = (params.options as string[])
      .slice(0, MAX_HUMAN_INPUT_OPTIONS_COUNT)
      .map((o) => sanitizeUserInput(o).slice(0, MAX_HUMAN_INPUT_OPTION_LENGTH));
    if (options.length === 0) options = null;
  }

  // Fetch task title (user_id verified against token below)
  const taskRow = await env.DATABASE.prepare(
    `SELECT user_id, title, chat_session_id FROM tasks WHERE id = ? AND project_id = ?`
  )
    .bind(tokenData.taskId, tokenData.projectId)
    .first<{
      user_id: string;
      title: string;
      chat_session_id: string | null;
    }>();

  if (!taskRow) {
    return jsonRpcError(requestId, INTERNAL_ERROR, 'Task not found');
  }

  // Verify task ownership matches token — use tokenData.userId as authoritative target
  if (taskRow.user_id !== tokenData.userId) {
    log.error('mcp.request_human_input.user_id_mismatch', {
      tokenUserId: tokenData.userId,
      taskUserId: taskRow.user_id,
      taskId: tokenData.taskId,
    });
    return jsonRpcError(requestId, INTERNAL_ERROR, 'Task ownership mismatch');
  }

  const sessionId =
    tokenData.chatSessionId ??
    taskRow.chat_session_id ??
    (await notificationService.getChatSessionId(env, tokenData.workspaceId));
  if (!sessionId) {
    log.error('mcp.request_human_input.chat_session_missing', {
      taskId: tokenData.taskId,
      projectId: tokenData.projectId,
      workspaceId: tokenData.workspaceId,
    });
    return jsonRpcError(
      requestId,
      INTERNAL_ERROR,
      'Human input request could not be recorded because the chat session is missing'
    );
  }

  const schedule = computeHumanInputSchedule(env);
  let marker: Awaited<ReturnType<typeof projectDataService.createAttentionMarker>>;
  try {
    marker = await projectDataService.createAttentionMarker(env, tokenData.projectId, {
      sessionId,
      taskId: tokenData.taskId,
      workspaceId: tokenData.workspaceId,
      kind: 'needs_input',
      source: 'request_human_input',
      notificationUserId: tokenData.userId,
      reason: sanitizedContext,
      metadata: category || options ? JSON.stringify({ category, options }) : null,
      ...schedule,
    });
  } catch (err) {
    log.error('mcp.request_human_input.attention_marker_failed', {
      taskId: tokenData.taskId,
      error: err instanceof Error ? err.message : String(err),
    });
    return jsonRpcError(
      requestId,
      INTERNAL_ERROR,
      'Human input request could not be recorded safely'
    );
  }

  let notificationScheduled = false;
  if (env.NOTIFICATION) {
    try {
      const projectName = await notificationService.getProjectName(env, tokenData.projectId);
      const notification = await notificationService.notifyNeedsInput(env, tokenData.userId, {
        projectId: tokenData.projectId,
        projectName,
        taskId: tokenData.taskId,
        taskTitle: taskRow.title,
        context: sanitizedContext,
        category,
        options,
        sessionId,
        attentionMarkerId: marker.id,
      });
      notificationScheduled = notification.id !== 'suppressed';
      if (notificationScheduled) {
        await projectDataService.linkAttentionNotification(
          env,
          tokenData.projectId,
          marker.id,
          tokenData.userId,
          notification.id
        );
      }
    } catch (err) {
      log.warn('mcp.request_human_input.notification_failed', {
        taskId: tokenData.taskId,
        markerId: marker.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  log.info('mcp.request_human_input', {
    taskId: tokenData.taskId,
    projectId: tokenData.projectId,
    category,
    hasOptions: options !== null,
  });

  return jsonRpcSuccess(requestId, {
    content: [
      {
        type: 'text',
        text: notificationScheduled
          ? 'Human input request recorded. Notification delivery has been scheduled. You may continue working or end your turn.'
          : 'Human input request recorded, but notification delivery was not scheduled. SAM will keep the task alive while waiting for delivery. You may continue working.',
      },
    ],
  });
}
