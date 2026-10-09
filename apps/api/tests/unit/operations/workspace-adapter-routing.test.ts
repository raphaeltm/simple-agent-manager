import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { OperationError } from '../../../src/operations/errors';
import * as platform from '../../../src/operations/platform-operations';
import { runWorkspaceOperation } from '../../../src/operations/workspace-adapter';
import type { McpTokenData } from '../../../src/services/mcp-token';

// Catalog order is not part of the workspace tool contract.
vi.mock('../../../src/operations/platform-operations', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('../../../src/operations/platform-operations')>();
  return { ...original, platformOperations: [...original.platformOperations].reverse() };
});

afterEach(() => vi.restoreAllMocks());

const routes = [
  ['get_task_details', 'sam_task_get', platform.samTaskGet],
  ['list_tasks', 'sam_tasks_list', platform.samTasksList],
  ['search_tasks', 'sam_tasks_list', platform.samTasksList],
  ['get_session_messages', 'sam_chat_read', platform.samChatRead],
  ['search_messages', 'sam_chats_search', platform.samChatsSearch],
  ['list_ideas', 'sam_ideas_search', platform.samIdeasSearch],
  ['search_ideas', 'sam_ideas_search', platform.samIdeasSearch],
  ['find_related_ideas', 'sam_ideas_search', platform.samIdeasSearch],
  ['get_idea', 'sam_idea_get', platform.samIdeaGet],
  ['create_idea', 'sam_idea_create', platform.samIdeaCreate],
  ['update_idea', 'sam_idea_update', platform.samIdeaUpdate],
  ['search_knowledge', 'sam_knowledge_search', platform.samKnowledgeSearch],
  ['list_agent_profiles', 'sam_profiles_list', platform.samProfilesList],
] as const;

describe('workspace tool routing is independent of catalog order', () => {
  it.each(routes)('%s invokes %s', async (toolName, operationName, operation) => {
    expect(operation.name).toBe(operationName);
    const run = vi
      .spyOn(operation, 'run')
      .mockRejectedValue(new OperationError('conflict', operationName));
    const token = {
      projectId: 'project',
      userId: 'owner',
      workspaceId: 'workspace',
      taskId: 'task',
    } as McpTokenData;
    const response = await runWorkspaceOperation(
      toolName,
      'request',
      { query: 'needle' },
      token,
      {} as Env
    );
    expect(run).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: expect.objectContaining({ userId: 'owner', via: 'workspace-agent' }),
      }),
      {
        query: 'needle',
        projectId: 'project',
        ...(toolName === 'find_related_ideas' ? { related: true } : {}),
        ...(toolName === 'search_tasks' || toolName === 'search_ideas' ? { search: true } : {}),
      }
    );
    expect(response).toMatchObject({ error: { message: operationName } });
  });
});
