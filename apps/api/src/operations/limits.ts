import type { Env } from '../env';
import { parsePositiveInt } from '../lib/route-helpers';

/** Limits shared by the operations and their workspace adapter. */
export function getPlatformOperationLimits(env: Env) {
  return {
    taskListLimit: parsePositiveInt(env.MCP_TASK_LIST_LIMIT, 10),
    taskListMax: parsePositiveInt(env.MCP_TASK_LIST_MAX, 50),
    taskSearchLimit: parsePositiveInt(env.MCP_TASK_SEARCH_LIMIT, 10),
    taskSearchMax: parsePositiveInt(env.MCP_TASK_SEARCH_MAX, 20),
    taskDetailRecentMessageLimit: parsePositiveInt(env.MCP_TASK_DETAIL_RECENT_MESSAGE_LIMIT, 5),
    taskDetailMessageSnippetLength: parsePositiveInt(
      env.MCP_TASK_DETAIL_MESSAGE_SNIPPET_LENGTH,
      2000
    ),
    messageListLimit: parsePositiveInt(env.MCP_MESSAGE_LIST_LIMIT, 50),
    messageListMax: parsePositiveInt(env.MCP_MESSAGE_LIST_MAX, 200),
    messageSearchMax: parsePositiveInt(env.MCP_MESSAGE_SEARCH_MAX, 20),
    messageSearchLimit: parsePositiveInt(env.MCP_MESSAGE_SEARCH_LIMIT, 10),
    taskDescriptionSnippetLength: parsePositiveInt(env.MCP_TASK_DESCRIPTION_SNIPPET_LENGTH, 200),
    ideaContentMaxLength: parsePositiveInt(env.MCP_IDEA_CONTENT_MAX_LENGTH, 65_536),
    ideaListLimit: parsePositiveInt(env.MCP_IDEA_LIST_LIMIT, 20),
    ideaListMax: parsePositiveInt(env.MCP_IDEA_LIST_MAX, 100),
    ideaSearchMax: parsePositiveInt(env.MCP_IDEA_SEARCH_MAX, 20),
    relatedIdeaSearchLimit: parsePositiveInt(env.MCP_RELATED_IDEA_SEARCH_LIMIT, 10),
    ideaTitleMaxLength: parsePositiveInt(env.MCP_IDEA_TITLE_MAX_LENGTH, 200),
    dispatchMaxPriority: parsePositiveInt(env.MCP_DISPATCH_MAX_PRIORITY, 100),
    knowledgeSearchLimit: parsePositiveInt(env.KNOWLEDGE_SEARCH_LIMIT, 20),
  };
}
