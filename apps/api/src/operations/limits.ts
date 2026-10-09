import type { Env } from '../env';
import { parsePositiveInt } from '../lib/route-helpers';

/** Limits shared by the operations and their workspace adapter. */
export function getPlatformOperationLimits(env: Env) {
  return {
    taskListLimit: 10,
    taskListMax: 50,
    taskSearchMax: 20,
    messageListLimit: parsePositiveInt(env.MCP_MESSAGE_LIST_LIMIT, 50),
    messageListMax: parsePositiveInt(env.MCP_MESSAGE_LIST_MAX, 200),
    messageSearchMax: parsePositiveInt(env.MCP_MESSAGE_SEARCH_MAX, 20),
    taskDescriptionSnippetLength: parsePositiveInt(env.MCP_TASK_DESCRIPTION_SNIPPET_LENGTH, 200),
    ideaContentMaxLength: parsePositiveInt(env.MCP_IDEA_CONTENT_MAX_LENGTH, 65_536),
    ideaListLimit: parsePositiveInt(env.MCP_IDEA_LIST_LIMIT, 20),
    ideaListMax: parsePositiveInt(env.MCP_IDEA_LIST_MAX, 100),
    ideaSearchMax: parsePositiveInt(env.MCP_IDEA_SEARCH_MAX, 20),
    ideaTitleMaxLength: parsePositiveInt(env.MCP_IDEA_TITLE_MAX_LENGTH, 200),
    dispatchMaxPriority: parsePositiveInt(env.MCP_DISPATCH_MAX_PRIORITY, 100),
    knowledgeSearchLimit: parsePositiveInt(env.KNOWLEDGE_SEARCH_LIMIT, 20),
  };
}
