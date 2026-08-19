import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';

import {
  agentQueryKeys,
  chatQueryKeys,
  credentialQueryKeys,
  nodeQueryKeys,
  notificationQueryKeys,
  projectQueryKeys,
  taskQueryKeys,
  trialQueryKeys,
  workspaceQueryKeys,
} from '../../../src/lib/query-options';
import {
  PERSISTED_QUERY_OPERATIONS,
  shouldDehydratePersistedQuery,
} from '../../../src/lib/query-persist-config';

/**
 * Guards the persistence security boundary while the query surface grows.
 *
 * `tasks/backlog/2026-08-07-expand-frontend-query-cache-and-persistence.md` bans
 * writing credentials/tokens, chat or agent free text, and node/workspace runtime
 * detail to disk without a separate security review. Migrating a loader to TanStack
 * Query puts its response into the query cache, which is exactly what the persister
 * dehydrates from — so every key added by the migration has to be checked against
 * the allowlist, not just assumed safe because it is new.
 */

const SCOPE = 'user-1';

function queryFor(queryKey: readonly unknown[]) {
  const client = new QueryClient();
  client.setQueryData(queryKey, { anything: true });
  const query = client.getQueryCache().find({ queryKey });
  if (!query) throw new Error(`query not found for key ${JSON.stringify(queryKey)}`);
  return query;
}

describe('persisted query allowlist', () => {
  it('allows only explicitly reviewed operations', () => {
    expect([...PERSISTED_QUERY_OPERATIONS]).toEqual(['projects/list', 'sessions/messages']);
  });

  it('persists the project list, which carries no user or agent free text', () => {
    expect(shouldDehydratePersistedQuery(queryFor(projectQueryKeys.list(SCOPE, 50)), SCOPE)).toBe(
      true
    );
  });

  it('persists approved project chat session messages under the authenticated scope', () => {
    expect(
      shouldDehydratePersistedQuery(
        queryFor(chatQueryKeys.sessionMessages(SCOPE, 'project-1', 'session-1')),
        SCOPE
      )
    ).toBe(true);
  });

  it.each([
    ['credentials', credentialQueryKeys.list(SCOPE)],
    ['agent catalog', agentQueryKeys.catalog(SCOPE)],
    ['agent credentials', agentQueryKeys.credentials(SCOPE)],
    ['agent profiles', agentQueryKeys.profileList(SCOPE, 'project-1')],
    ['trial status', trialQueryKeys.status(SCOPE)],
    ['active tasks', taskQueryKeys.active(SCOPE)],
    ['recent chats', chatQueryKeys.recent(SCOPE, 8, 1_000)],
    ['all chats', chatQueryKeys.list(SCOPE, 100)],
    ['node list', nodeQueryKeys.list(SCOPE)],
    ['provider catalog', nodeQueryKeys.catalog(SCOPE)],
    ['workspace list', workspaceQueryKeys.list(SCOPE)],
    ['notification preferences', notificationQueryKeys.preferences(SCOPE)],
    ['project detail', projectQueryKeys.detail(SCOPE, 'project-1')],
  ])('never writes %s to disk', (_label, key) => {
    expect(shouldDehydratePersistedQuery(queryFor(key), SCOPE)).toBe(false);
  });

  it('refuses to persist a key belonging to a different scope', () => {
    const otherScope = projectQueryKeys.list('user-2', 50);
    expect(shouldDehydratePersistedQuery(queryFor(otherScope), SCOPE)).toBe(false);
  });

  it('persists nothing at all when there is no authenticated scope', () => {
    expect(shouldDehydratePersistedQuery(queryFor(projectQueryKeys.list('', 50)), '')).toBe(false);
  });
});

describe('query key shape invariant', () => {
  /**
   * `shouldDehydratePersistedQuery` parses keys positionally, so a key that does not
   * lead with `['auth', scope, domain, operation]` silently loses both its scope
   * isolation and its ability to ever be persisted.
   */
  it.each([
    ['credentials', credentialQueryKeys.list(SCOPE)],
    ['agent catalog', agentQueryKeys.catalog(SCOPE)],
    ['agent profiles', agentQueryKeys.profileList(SCOPE, 'project-1')],
    ['trial status', trialQueryKeys.status(SCOPE)],
    ['active tasks', taskQueryKeys.active(SCOPE)],
    ['recent chats', chatQueryKeys.recent(SCOPE, 8, 1_000)],
    ['all chats', chatQueryKeys.list(SCOPE, 100)],
    ['chat session messages', chatQueryKeys.sessionMessages(SCOPE, 'project-1', 'session-1')],
    ['node list', nodeQueryKeys.list(SCOPE)],
    ['provider catalog', nodeQueryKeys.catalog(SCOPE)],
    ['workspace list', workspaceQueryKeys.list(SCOPE)],
    ['notification preferences', notificationQueryKeys.preferences(SCOPE)],
    ['project list', projectQueryKeys.list(SCOPE, 50)],
  ])('%s is identity-scoped', (_label, key) => {
    expect(key[0]).toBe('auth');
    expect(key[1]).toBe(SCOPE);
    expect(typeof key[2]).toBe('string');
    expect(typeof key[3]).toBe('string');
  });

  it('produces different keys for different identities', () => {
    expect(credentialQueryKeys.list('user-1')).not.toEqual(credentialQueryKeys.list('user-2'));
    expect(agentQueryKeys.profileList('user-1', 'p1')).not.toEqual(
      agentQueryKeys.profileList('user-2', 'p1')
    );
  });
});
