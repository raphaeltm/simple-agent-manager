import * as v from 'valibot';

import { authorizeProjectOperation } from './authorization';
import { readChat, searchChats } from './chat-core';
import { createIdea, getIdea, searchIdeas, updateIdea } from './idea-core';
import { listProfiles, searchKnowledge } from './memory-core';
import { getTask, listTasks } from './task-core';
import { defineOperation } from './types';

const base = { projectId: v.string() };
const ideaFields = { ideaId: v.string() };

export const samTaskGet = defineOperation({
  name: 'sam_task_get',
  title: 'Get task',
  description: 'Use this when you need task status, output, and the latest assistant message.',
  kind: 'read',
  input: v.object({ ...base, taskId: v.string() }),
  async run(ctx, input) {
    await authorizeProjectOperation(ctx, input.projectId);
    return getTask(ctx, input.projectId, input.taskId);
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
    return listTasks(ctx, input);
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
    return readChat(ctx, input);
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
    return searchChats(ctx, input);
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
    return searchIdeas(ctx, input);
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
    return getIdea(ctx, input.projectId, input.ideaId);
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
    return createIdea(ctx, input);
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
    return updateIdea(ctx, input);
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
    return searchKnowledge(ctx, input);
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
    return listProfiles(ctx, input.projectId);
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
