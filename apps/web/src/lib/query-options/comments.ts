import { queryOptions } from '@tanstack/react-query';

import { listMessageComments, type MessageCommentThread } from '../api/comments';

export const messageCommentQueryKeys = {
  all: (queryScope: string) => ['auth', queryScope, 'message-comments'] as const,
  session: (queryScope: string, projectId: string, sessionId: string) =>
    [...messageCommentQueryKeys.all(queryScope), 'session', projectId, sessionId] as const,
};

export function messageCommentsQueryOptions(
  queryScope: string,
  projectId: string,
  sessionId: string
) {
  return queryOptions({
    queryKey: messageCommentQueryKeys.session(queryScope, projectId, sessionId),
    queryFn: async ({ signal }): Promise<MessageCommentThread[]> =>
      (await listMessageComments(projectId, sessionId, { signal })).comments,
  });
}
