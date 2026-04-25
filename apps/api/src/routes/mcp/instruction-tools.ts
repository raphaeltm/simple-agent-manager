/**
 * MCP instruction tools — get_instructions and request_human_input.
 */
import type { HumanInputCategory } from '@simple-agent-manager/shared';
import { HUMAN_INPUT_CATEGORIES, KNOWLEDGE_DEFAULTS, MAX_HUMAN_INPUT_CONTEXT_LENGTH, MAX_HUMAN_INPUT_OPTION_LENGTH, MAX_HUMAN_INPUT_OPTIONS_COUNT } from '@simple-agent-manager/shared';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../../db/schema';
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

export async function handleGetInstructions(
  requestId: string | number | null,
  tokenData: McpTokenData,
  env: Env,
): Promise<JsonRpcResponse> {
  const db = drizzle(env.DATABASE, { schema });

  // Fetch task
  const taskRows = await db
    .select()
    .from(schema.tasks)
    .where(
      and(
        eq(schema.tasks.id, tokenData.taskId),
        eq(schema.tasks.projectId, tokenData.projectId),
      ),
    )
    .limit(1);

  const task = taskRows[0];
  if (!task) {
    return jsonRpcError(requestId, INTERNAL_ERROR, 'Task not found');
  }

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

  // Auto-retrieve ALL high-confidence knowledge for this project.
  // Instead of keyword-matching against the task title (which misses most relevant
  // knowledge), we retrieve all observations above a confidence threshold. For typical
  // projects with <50 observations, this is a small amount of text that gives the agent
  // full context about user preferences, project conventions, and decisions.
  const minConfidence = parseFloat(env.KNOWLEDGE_AUTO_RETRIEVE_MIN_CONFIDENCE || '') || KNOWLEDGE_DEFAULTS.autoRetrieveMinConfidence;
  const highConfidenceLimit = parseInt(env.KNOWLEDGE_AUTO_RETRIEVE_HIGH_CONFIDENCE_LIMIT || '', 10) || KNOWLEDGE_DEFAULTS.autoRetrieveHighConfidenceLimit;
  let knowledgeContext: { entityName: string; entityType: string; observation: string; confidence: number }[] = [];
  try {
    const allHighConfidence = await projectDataService.getAllHighConfidenceKnowledge(
      env, tokenData.projectId, minConfidence, highConfidenceLimit,
    );
    knowledgeContext = allHighConfidence.map((r) => ({
      entityName: r.entityName,
      entityType: r.entityType,
      observation: r.content,
      confidence: r.confidence,
    }));
  } catch (err) {
    log.warn('mcp.get_instructions.knowledge_retrieval_failed', {
      projectId: tokenData.projectId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Format knowledge as actionable directives grouped by entity, not raw JSON.
  // Agents are more likely to apply knowledge when it reads like instructions.
  const knowledgeDirectives = formatKnowledgeDirectives(knowledgeContext);

  // Build knowledge-related instructions based on whether knowledge exists
  const knowledgeInstructions = buildKnowledgeInstructions(
    knowledgeContext.length > 0,
    task.taskMode === 'conversation',
  );

  const result = {
    task: {
      id: task.id,
      title: task.title,
      description: task.description,
      status: task.status,
      priority: task.priority,
      outputBranch: task.outputBranch,
    },
    project: {
      id: project.id,
      name: project.name,
      repository: project.repository,
      defaultBranch: project.defaultBranch,
      repoProvider: project.repoProvider || 'github',
    },
    instructions: [
      ...(task.taskMode === 'conversation'
        ? [
            'You are in a conversation with a human. Respond to their messages directly.',
            'Use `dispatch_task` to spawn follow-up work to other agents when needed.',
            'Use `update_task_status` to report significant findings or progress.',
            'Do NOT call `complete_task` — the human will end the conversation when they are ready.',
            'If you encounter blockers, report them via `update_task_status` with a clear description.',
          ]
        : [
            'Call `update_task_status` to report progress as you complete significant milestones.',
            'Call `complete_task` with a summary when all work is done.',
            'Push your changes to the output branch before calling `complete_task`.',
            'If you encounter blockers, report them via `update_task_status` with a clear description.',
          ]),
      ...knowledgeInstructions,
      ...((project.repoProvider === 'artifacts')
        ? [
            'This project uses SAM Git (Cloudflare Artifacts) — NOT GitHub.',
            'Do NOT use `gh pr create`, `gh` CLI, or any GitHub-specific commands.',
            'Push your changes directly to the remote branch. Summarize your changes in the task completion message.',
          ]
        : []),
    ],
    // Include formatted directives as a readable text block (primary way agents consume knowledge)
    ...(knowledgeDirectives ? { knowledgeDirectives } : {}),
    // Also include structured data for programmatic use
    ...(knowledgeContext.length > 0 ? { knowledgeContext } : {}),
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
 * Build knowledge graph instructions based on whether knowledge exists
 * and the session mode. Conversation mode gets more aggressive capture
 * instructions since direct user interaction is the richest source.
 */
function buildKnowledgeInstructions(hasKnowledge: boolean, isConversation: boolean): string[] {
  const instructions: string[] = [];

  // Core directive — MUST, not "you can"
  instructions.push(
    'You MUST use the knowledge graph to remember important facts about the user and project across sessions.',
  );

  // When to SAVE — concrete trigger patterns
  instructions.push(
    'Save to knowledge graph (via `add_knowledge`) when ANY of these happen: '
    + '(1) User corrects you or says "don\'t do X" → sourceType "explicit", confidence 0.9+. '
    + '(2) User states a preference ("I prefer...", "always use...", "never...") → sourceType "explicit", confidence 0.9+. '
    + '(3) User describes their role, expertise, or background → entityType "expertise". '
    + '(4) You learn a project convention or architecture decision → entityType "context". '
    + '(5) User gives feedback on your response style → entityType "preference".',
  );

  // When to READ — decision-point retrieval (Layer 2)
  instructions.push(
    'Search knowledge (via `search_knowledge`) BEFORE making key decisions: '
    + 'before writing content/blogs → search "ContentStyle"; '
    + 'before choosing libraries/tools → search "CodeQuality"; '
    + 'before UI layout decisions → search "User" and "mobile"; '
    + 'before architecture decisions → search "Architecture"; '
    + 'before pricing/business decisions → search "BusinessStrategy".',
  );

  // What NOT to save
  instructions.push(
    'Do NOT save to knowledge: code patterns derivable from the codebase, git history, ephemeral task details, or things already in CLAUDE.md or project config.',
  );

  if (hasKnowledge) {
    // Knowledge exists — tell agent to apply it and maintain it
    instructions.push(
      'The knowledgeDirectives field above contains stored knowledge from previous sessions. Apply these preferences and facts to your work. '
      + 'If any observation seems outdated, call `update_knowledge` or `remove_knowledge`. '
      + 'If you verify an observation is still accurate, call `confirm_knowledge` to keep it fresh.',
    );
  } else {
    // Empty knowledge graph — bootstrapping prompt
    instructions.push(
      'This project has no stored knowledge yet. '
      + 'Actively look for user preferences, project conventions, and important context to store. '
      + 'If this is a conversation, ask the user about their preferences when relevant. '
      + 'You can also search past conversations (via `search_messages`) for user preferences using queries like "prefer", "don\'t want", "I like", "always" to seed the knowledge graph.',
    );
  }

  if (isConversation) {
    instructions.push(
      'You are in a direct conversation — this is the richest source of user knowledge. '
      + 'Pay close attention to corrections, preferences, and context the user shares. '
      + 'Store important observations as you go, not just at the end.',
    );
  }

  return instructions;
}

export async function handleRequestHumanInput(
  requestId: string | number | null,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env,
): Promise<JsonRpcResponse> {
  const context = params.context;
  if (typeof context !== 'string' || !context.trim()) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'context is required and must be a non-empty string');
  }

  if (context.length > MAX_HUMAN_INPUT_CONTEXT_LENGTH) {
    return jsonRpcError(
      requestId,
      INVALID_PARAMS,
      `context exceeds maximum length of ${MAX_HUMAN_INPUT_CONTEXT_LENGTH} characters`,
    );
  }

  // Sanitize context: strip null bytes, Unicode bidi overrides, and C0/C1 control chars (except \n, \t)
  const sanitizedContext = sanitizeUserInput(context.trim());

  // Validate category if provided
  let category: HumanInputCategory | null = null;
  if (params.category !== undefined) {
    if (typeof params.category !== 'string' || !(HUMAN_INPUT_CATEGORIES as readonly string[]).includes(params.category)) {
      return jsonRpcError(requestId, INVALID_PARAMS, `category must be one of: ${HUMAN_INPUT_CATEGORIES.join(', ')}`);
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
    `SELECT user_id, title FROM tasks WHERE id = ? AND project_id = ?`,
  ).bind(tokenData.taskId, tokenData.projectId).first<{
    user_id: string;
    title: string;
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

  // Emit high-urgency notification (best-effort)
  if (env.NOTIFICATION) {
    try {
      const [projectName, sessionId] = await Promise.all([
        notificationService.getProjectName(env, tokenData.projectId),
        notificationService.getChatSessionId(env, tokenData.workspaceId),
      ]);
      await notificationService.notifyNeedsInput(env as any, tokenData.userId, {
        projectId: tokenData.projectId,
        projectName,
        taskId: tokenData.taskId,
        taskTitle: taskRow.title,
        context: sanitizedContext,
        category,
        options,
        sessionId,
      });
    } catch (err) {
      log.warn('mcp.request_human_input.notification_failed', {
        taskId: tokenData.taskId,
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
    content: [{ type: 'text', text: 'Human input request sent. The user has been notified. You may continue working or end your turn.' }],
  });
}
