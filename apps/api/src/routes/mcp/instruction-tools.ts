/**
 * MCP instruction tools — get_instructions (request_human_input lives in ./human-input-tool
 * and is re-exported here for existing importers).
 */
import { KNOWLEDGE_DEFAULTS } from '@simple-agent-manager/shared';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../../db/schema';
import type { KnowledgeEntityIndexEntry } from '../../durable-objects/project-data/knowledge';
import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { resolveAgentMessageChannelsConfig } from '../../services/agent-message-channels';
import * as projectDataService from '../../services/project-data';
import {
  INTERNAL_ERROR,
  jsonRpcError,
  type JsonRpcResponse,
  jsonRpcSuccess,
  type McpTokenData,
} from './_helpers';
import { buildEventingInstructions } from './instruction-eventing-guidance';
import {
  buildKnowledgeInstructions,
  buildPolicyInstructions,
  formatKnowledgeDirectives,
  formatKnowledgeEntityIndex,
  formatPolicyDirectives,
  type PolicyEntry,
  serializeRejection,
} from './instruction-formatting';

export { handleRequestHumanInput } from './human-input-tool';

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
  let policyContext: PolicyEntry[] = [];
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
      scope: p.scope,
      expiresAt: p.expiresAt,
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
            ...(context.task.coordinationChannel
              ? { coordinationChannel: context.task.coordinationChannel }
              : {}),
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
            'Call the SAM MCP `complete_task` tool with a summary when all work is done; when a pull request exists, pass its URL as `evidence.prUrl`.',
            'Push your changes to the output branch before calling the SAM MCP `complete_task` tool.',
            'If you encounter blockers, report them via the SAM MCP `update_task_status` tool with a clear description.',
          ]),
      // Event tools need a task-backed agent token.
      ...(tokenData.taskId
        ? buildEventingInstructions({
            coordinationChannel: context.task?.coordinationChannel ?? null,
            agentMessageChannelsEnabled: resolveAgentMessageChannelsConfig(env).enabled,
          })
        : []),
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
