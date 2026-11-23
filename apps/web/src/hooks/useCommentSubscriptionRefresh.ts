import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef } from 'react';

import { messageCommentQueryKeys } from '../lib/query-options/comments';
import { useQueryScope } from './useQueryScope';

/** Recover withheld comment deltas without reading inactive cached conversations. */
export function useCommentSubscriptionRefresh(projectId: string, sessionId?: string) {
  const client = useQueryClient();
  const scope = useQueryScope();
  const identity = `${scope}:${projectId}:${sessionId ?? ''}`;
  const current = useRef<string | null>(identity);
  current.current = identity;
  useEffect(() => {
    current.current = identity;
    return () => {
      current.current = null;
    };
  }, [identity]);

  return useCallback(async () => {
    if (!scope) return;
    const sessionKey = messageCommentQueryKeys.session(scope, projectId, sessionId ?? '');
    const prefix = sessionId ? sessionKey : sessionKey.slice(0, -1);
    const queries = client.getQueryCache().findAll({ queryKey: prefix });
    await Promise.all(
      queries.map(async (query) => {
        // An initial fetch with no cached data cannot be cancelled by invalidation. Join it,
        // then fetch after admission; otherwise it can commit a pre-subscription snapshot.
        if (query.isActive()) await query.promise?.catch(() => undefined);
        if (current.current !== identity) return;
        await client.invalidateQueries(
          { queryKey: query.queryKey, exact: true },
          {
            cancelRefetch: false,
          }
        );
      })
    );
  }, [client, identity, projectId, scope, sessionId]);
}
