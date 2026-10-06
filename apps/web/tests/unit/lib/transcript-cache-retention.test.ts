/**
 * How long, and how many, chat transcripts the browser keeps.
 *
 * Both bounds act on the real TanStack cache: eviction removes queries from it,
 * and the dehydrate predicate decides what the persister writes from it. A
 * transcript that leaves memory also leaves the next persisted record, because
 * the record mirrors memory — except in size: on disk each transcript keeps only
 * its newest rows.
 */
import { persistQueryClient } from '@tanstack/query-persist-client-core';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { clear as idbClear, get as idbGet } from 'idb-keyval';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { chatQueryKeys, evictStaleTranscripts } from '../../../src/lib/query-options';
import {
  CHAT_TRANSCRIPT_CACHE_TTL_MS,
  CHAT_TRANSCRIPT_PERSIST_MAX_ROWS,
  QUERY_PERSIST_MAX_AGE_MS,
  QUERY_PERSIST_SCHEMA_VERSION,
  shouldDehydratePersistedQuery,
} from '../../../src/lib/query-persist-config';
import { createIdbQueryPersister } from '../../../src/lib/query-persistence';

const SCOPE = 'user-1';
const MINUTE = 60_000;

function transcriptKey(sessionId: string, scope = SCOPE) {
  return chatQueryKeys.sessionMessages(scope, 'project-1', sessionId);
}

function cacheTranscript(client: QueryClient, sessionId: string, updatedAt: number, scope = SCOPE) {
  client.setQueryData(
    transcriptKey(sessionId, scope),
    { session: { id: sessionId }, messages: [], hasMore: false, state: null },
    { updatedAt }
  );
}

function cachedSessions(client: QueryClient, scope = SCOPE): string[] {
  return client
    .getQueryCache()
    .findAll({ queryKey: chatQueryKeys.transcripts(scope) })
    .map((query) => String(query.queryKey[5]))
    .sort();
}

describe('transcript retention on disk', () => {
  afterEach(() => vi.useRealTimers());

  function transcriptUpdated(ageMs: number) {
    const client = new QueryClient();
    const now = 10 * CHAT_TRANSCRIPT_CACHE_TTL_MS;
    vi.useFakeTimers({ now });
    cacheTranscript(client, 'session-1', now - ageMs);
    return client.getQueryCache().find({ queryKey: transcriptKey('session-1') })!;
  }

  it('writes a transcript used within the retention window', () => {
    expect(
      shouldDehydratePersistedQuery(transcriptUpdated(CHAT_TRANSCRIPT_CACHE_TTL_MS - MINUTE), SCOPE)
    ).toBe(true);
  });

  it('stops writing a transcript once its last use is older than the window', () => {
    expect(
      shouldDehydratePersistedQuery(transcriptUpdated(CHAT_TRANSCRIPT_CACHE_TTL_MS + MINUTE), SCOPE)
    ).toBe(false);
  });
});

describe('transcript size on disk', () => {
  afterEach(async () => {
    await idbClear();
  });

  function transcript(sessionId: string, length: number) {
    return {
      session: { id: sessionId },
      messages: Array.from({ length }, (_, n) => ({
        id: `${sessionId}-m${n}`,
        sessionId,
        role: 'user',
        content: `row ${n}`,
        toolMetadata: null,
        createdAt: n,
        sequence: n,
      })),
      hasMore: false,
      state: null,
    };
  }

  type Written = {
    clientState: {
      queries: Array<{
        queryKey: unknown[];
        state: { data: { messages: Array<{ id: string }>; hasMore: boolean } };
      }>;
    };
  };

  it('writes only the newest rows of a long transcript, and reports the rest as older history', async () => {
    const client = new QueryClient();
    const persister = createIdbQueryPersister('transcript-size-test', { throttleMs: 0 });
    const [unsubscribe, restored] = persistQueryClient({
      queryClient: client,
      persister,
      maxAge: QUERY_PERSIST_MAX_AGE_MS,
      buster: QUERY_PERSIST_SCHEMA_VERSION,
      dehydrateOptions: {
        shouldDehydrateQuery: (query) => shouldDehydratePersistedQuery(query, SCOPE),
      },
    });
    await restored;

    // The reader paged far back in one chat; another is short.
    const long = CHAT_TRANSCRIPT_PERSIST_MAX_ROWS + 50;
    client.setQueryData(transcriptKey('paged-back'), transcript('paged-back', long));
    client.setQueryData(transcriptKey('short'), transcript('short', 3));

    const written = await vi.waitFor(async () => {
      const record = await idbGet<Written>('transcript-size-test');
      expect(record?.clientState.queries).toHaveLength(2);
      return record!;
    });
    const onDisk = (sessionId: string) =>
      written.clientState.queries.find((query) => query.queryKey[5] === sessionId)!.state.data;

    expect(onDisk('paged-back').messages).toHaveLength(CHAT_TRANSCRIPT_PERSIST_MAX_ROWS);
    expect(onDisk('paged-back').messages.at(-1)?.id).toBe(`paged-back-m${long - 1}`);
    expect(onDisk('paged-back').hasMore).toBe(true);
    expect(onDisk('short').messages).toHaveLength(3);
    expect(onDisk('short').hasMore).toBe(false);
    // Memory keeps everything the reader loaded.
    expect(
      client.getQueryData<{ messages: unknown[] }>(transcriptKey('paged-back'))?.messages
    ).toHaveLength(long);
    unsubscribe();
  });
});

describe('evictStaleTranscripts', () => {
  it('keeps the most recently updated transcripts and evicts the rest', () => {
    const client = new QueryClient();
    for (const [sessionId, updatedAt] of [
      ['oldest', 1_000],
      ['older', 2_000],
      ['newer', 3_000],
      ['newest', 4_000],
    ] as const) {
      cacheTranscript(client, sessionId, updatedAt);
    }

    evictStaleTranscripts(client, SCOPE, transcriptKey('newest'), 2);

    expect(cachedSessions(client)).toEqual(['newer', 'newest']);
  });

  it('never evicts a transcript on screen, or the one being opened', () => {
    const client = new QueryClient();
    cacheTranscript(client, 'on-screen', 1_000);
    cacheTranscript(client, 'opening', 2_000);
    cacheTranscript(client, 'recent', 3_000);
    cacheTranscript(client, 'stale', 500);
    const onScreen = new QueryObserver(client, {
      queryKey: transcriptKey('on-screen'),
      enabled: false,
    });
    const unsubscribe = onScreen.subscribe(() => {});

    evictStaleTranscripts(client, SCOPE, transcriptKey('opening'), 1);

    // `recent` fills the one slot; the viewed and the opening transcripts are
    // kept regardless, however old; only the unviewed stale one goes.
    expect(cachedSessions(client)).toEqual(['on-screen', 'opening', 'recent']);
    unsubscribe();
  });

  it("leaves another account's transcripts alone", () => {
    const client = new QueryClient();
    cacheTranscript(client, 'mine', 2_000);
    cacheTranscript(client, 'theirs-old', 1_000, 'user-2');
    cacheTranscript(client, 'theirs-new', 3_000, 'user-2');

    evictStaleTranscripts(client, SCOPE, transcriptKey('mine'), 1);

    expect(cachedSessions(client)).toEqual(['mine']);
    expect(cachedSessions(client, 'user-2')).toEqual(['theirs-new', 'theirs-old']);
  });
});
