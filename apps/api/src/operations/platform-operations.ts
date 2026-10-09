import * as v from 'valibot';

import type { JsonRpcResponse } from '../routes/mcp/_helpers';
import {
  handleCreateIdea,
  handleFindRelatedIdeas,
  handleGetIdea,
  handleListIdeas,
  handleSearchIdeas,
  handleUpdateIdea,
} from '../routes/mcp/idea-tools';
import { handleSearchKnowledge } from '../routes/mcp/knowledge-tools';
import { handleListAgentProfiles } from '../routes/mcp/profile-tools';
import { handleGetSessionMessages, handleSearchMessages } from '../routes/mcp/session-tools';
import { handleGetTaskDetails, handleListTasks, handleSearchTasks } from '../routes/mcp/task-tools';
import type { McpTokenData } from '../services/mcp-token';
import { authorizeProjectOperation } from './authorization';
import { OperationError } from './errors';
import { defineOperation, type OperationContext } from './types';

const base = { projectId: v.string() };
const ideaFields = { ideaId: v.string() };

type Handler = (
  id: string | number | null,
  params: Record<string, unknown>,
  token: McpTokenData,
  env: OperationContext['env']
) => Promise<JsonRpcResponse>;

/** Compatibility bridge while the workspace MCP implementation is moved into operation modules. */
async function runHandler(
  ctx: OperationContext,
  projectId: string,
  params: Record<string, unknown>,
  handler: Handler
): Promise<unknown> {
  const token: McpTokenData = {
    userId: ctx.actor.userId,
    projectId,
    workspaceId: ctx.actor.workspace?.workspaceId ?? '',
    taskId: ctx.actor.workspace?.taskId ?? '',
    createdAt: new Date().toISOString(),
  };
  const response = await handler(null, params, token, ctx.env);
  if (response.error) {
    throw new OperationError(
      response.error.code === -32602 ? 'invalid_input' : 'unavailable',
      response.error.message
    );
  }
  const result = response.result as
    { content?: Array<{ type: string; text?: string }> } | undefined;
  const text = result?.content?.find((item) => item.type === 'text')?.text;
  if (!text) throw new OperationError('unavailable', 'Tool returned no result');
  return JSON.parse(text) as unknown;
}

export const samTaskGet = defineOperation({
  name: 'sam_task_get',
  title: 'Get task',
  description: 'Use this when you need task status, output, and the latest assistant message.',
  kind: 'read',
  input: v.object({ ...base, taskId: v.string() }),
  async run(ctx, input) {
    await authorizeProjectOperation(ctx, input.projectId);
    return runHandler(ctx, input.projectId, { taskId: input.taskId }, handleGetTaskDetails);
  },
});

export const samTasksList = defineOperation({
  name: 'sam_tasks_list',
  title: 'List or search tasks',
  description: 'Use this when you need recent tasks or tasks matching a query.',
  kind: 'read',
  input: v.object({
    ...base,
    query: v.optional(v.string()),
    search: v.optional(v.boolean()),
    status: v.optional(v.string()),
    include_own: v.optional(v.boolean()),
    limit: v.optional(v.number()),
  }),
  async run(ctx, input) {
    await authorizeProjectOperation(ctx, input.projectId);
    const { projectId, search, ...params } = input;
    return runHandler(
      ctx,
      projectId,
      params,
      search || input.query !== undefined ? handleSearchTasks : handleListTasks
    );
  },
});

export const samChatRead = defineOperation({
  name: 'sam_chat_read',
  title: 'Read chat',
  description: 'Use this when you need messages from a project chat session.',
  kind: 'read',
  input: v.object({
    ...base,
    sessionId: v.string(),
    limit: v.optional(v.number()),
    roles: v.optional(v.array(v.string())),
  }),
  async run(ctx, input) {
    await authorizeProjectOperation(ctx, input.projectId);
    const { projectId, ...params } = input;
    return runHandler(ctx, projectId, params, handleGetSessionMessages);
  },
});

export const samChatsSearch = defineOperation({
  name: 'sam_chats_search',
  title: 'Search chats',
  description: 'Use this when you need to find messages in project chats.',
  kind: 'read',
  input: v.object({
    ...base,
    query: v.string(),
    sessionId: v.optional(v.string()),
    roles: v.optional(v.array(v.string())),
    limit: v.optional(v.number()),
    continuation: v.optional(v.string()),
  }),
  async run(ctx, input) {
    await authorizeProjectOperation(ctx, input.projectId);
    const { projectId, ...params } = input;
    return runHandler(ctx, projectId, params, handleSearchMessages);
  },
});

export const samIdeasSearch = defineOperation({
  name: 'sam_ideas_search',
  title: 'Search ideas',
  description: 'Use this when you need project ideas by recency or search terms.',
  kind: 'read',
  input: v.object({
    ...base,
    query: v.optional(v.string()),
    search: v.optional(v.boolean()),
    status: v.optional(v.string()),
    limit: v.optional(v.number()),
    related: v.optional(v.boolean()),
  }),
  async run(ctx, input) {
    await authorizeProjectOperation(ctx, input.projectId);
    const { projectId, related, search, ...params } = input;
    return runHandler(
      ctx,
      projectId,
      params,
      related
        ? handleFindRelatedIdeas
        : search || input.query !== undefined
          ? handleSearchIdeas
          : handleListIdeas
    );
  },
});

export const samIdeaGet = defineOperation({
  name: 'sam_idea_get',
  title: 'Get idea',
  description: 'Use this when you need full idea content and status.',
  kind: 'read',
  input: v.object({ ...base, ...ideaFields }),
  async run(ctx, input) {
    await authorizeProjectOperation(ctx, input.projectId);
    return runHandler(ctx, input.projectId, { ideaId: input.ideaId }, handleGetIdea);
  },
});

export const samIdeaCreate = defineOperation({
  name: 'sam_idea_create',
  title: 'Create idea',
  description: 'Use this when you want to record a new project idea.',
  kind: 'write',
  input: v.object({
    ...base,
    title: v.string(),
    content: v.optional(v.string()),
    priority: v.optional(v.number()),
  }),
  async run(ctx, input) {
    await authorizeProjectOperation(ctx, input.projectId, 'task:write');
    const { projectId, ...params } = input;
    return runHandler(ctx, projectId, params, handleCreateIdea);
  },
});

export const samIdeaUpdate = defineOperation({
  name: 'sam_idea_update',
  title: 'Update idea',
  description: 'Use this when you want to edit or change the status of a project idea.',
  kind: 'write',
  input: v.object({
    ...base,
    ...ideaFields,
    title: v.optional(v.string()),
    content: v.optional(v.string()),
    append: v.optional(v.boolean()),
    priority: v.optional(v.number()),
    status: v.optional(v.string()),
  }),
  async run(ctx, input) {
    await authorizeProjectOperation(ctx, input.projectId, 'task:write');
    const { projectId, ...params } = input;
    return runHandler(ctx, projectId, params, handleUpdateIdea);
  },
});

export const samKnowledgeSearch = defineOperation({
  name: 'sam_knowledge_search',
  title: 'Search knowledge',
  description: 'Use this when you need facts and preferences saved for a project.',
  kind: 'read',
  input: v.object({
    ...base,
    query: v.string(),
    entityType: v.optional(v.string()),
    minConfidence: v.optional(v.number()),
    limit: v.optional(v.number()),
  }),
  async run(ctx, input) {
    await authorizeProjectOperation(ctx, input.projectId);
    const { projectId, ...params } = input;
    return runHandler(ctx, projectId, params, handleSearchKnowledge);
  },
});

export const samProfilesList = defineOperation({
  name: 'sam_profiles_list',
  title: 'List agent profiles',
  description: 'Use this when you need available agent profiles in a project.',
  kind: 'read',
  input: v.object(base),
  async run(ctx, input) {
    await authorizeProjectOperation(ctx, input.projectId);
    return runHandler(ctx, input.projectId, {}, handleListAgentProfiles);
  },
});

export const platformOperations = [
  samTaskGet,
  samTasksList,
  samChatRead,
  samChatsSearch,
  samIdeasSearch,
  samIdeaGet,
  samIdeaCreate,
  samIdeaUpdate,
  samKnowledgeSearch,
  samProfilesList,
] as const;
