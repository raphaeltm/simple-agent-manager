/**
 * Shared Workers-runtime fixtures for grouped/FTS pruning tests (operator wall recovery and the
 * storage alarm's cleanup): sessions built through the real persistence and stop path, so grouped
 * rows and FTS entries come from production materialization, plus index-level assertions.
 */
import { env, runInDurableObject } from 'cloudflare:test';

import type { ProjectDataTestDouble } from '../support/expected-error-doubles';
import { seedInstallation, seedProject, seedUser } from './seed-d1';

const OWNER = 'grouped-fts-owner';
const INSTALLATION = 'grouped-fts-installation';
export const DAY_MS = 24 * 60 * 60 * 1000;
export const STORAGE_FULL = 'Exceeded the maximum database size.';

export type Stub = DurableObjectStub<ProjectDataTestDouble>;

/** A seeded project whose ProjectData object knows its projectId. */
export async function createProject(
  label: string,
  prefix = 'grouped-fts'
): Promise<{ projectId: string; stub: Stub }> {
  const projectId = `${prefix}-${label}-${crypto.randomUUID()}`;
  await seedUser(OWNER);
  await seedInstallation(INSTALLATION, OWNER);
  await seedProject(projectId, OWNER, INSTALLATION, { name: `Grouped FTS ${projectId}` });
  const stub = env.PROJECT_DATA.get(env.PROJECT_DATA.idFromName(projectId)) as Stub;
  await stub.ensureProjectId(projectId);
  return { projectId, stub };
}

export type SeedSession = {
  label: string;
  /** Assistant/user turns; each assistant message becomes its own grouped row. */
  turns: number;
  /** 'stop' is terminal; 'sleep' materializes the index but stays non-terminal. */
  end?: 'stop' | 'sleep';
  ageDays?: number;
};

export type SeededSession = { sessionId: string; token: string; before: SessionSnapshot };

/**
 * Builds sessions through the real persistence + stop path so grouped rows and
 * FTS entries are produced by production materialization, not hand-inserted.
 * Each session carries a unique search token and is snapshotted after seeding.
 */
export async function seedSessions(stub: Stub, sessions: SeedSession[]): Promise<SeededSession[]> {
  const seeded = await runInDurableObject(stub, async (instance, state) => {
    const out: Array<{ sessionId: string; token: string }> = [];
    for (const spec of sessions) {
      const token = `${spec.label}${crypto.randomUUID().replace(/-/g, '')}`;
      const sessionId = await instance.createSession(null, spec.label);
      for (let i = 0; i < spec.turns; i++) {
        await instance.persistMessage(sessionId, 'user', `question ${i} ${token}`, null, null);
        await instance.persistMessage(
          sessionId,
          'assistant',
          `answer ${i} mentions ${token} ${'x'.repeat(200)}`,
          null,
          null
        );
      }
      if ((spec.end ?? 'stop') === 'stop') await instance.stopSession(sessionId);
      else await instance.sleepSession(sessionId);
      state.storage.sql.exec(
        'UPDATE chat_sessions SET updated_at = ? WHERE id = ?',
        Date.now() - (spec.ageDays ?? 30) * DAY_MS,
        sessionId
      );
      out.push({ sessionId, token });
    }
    return out;
  });
  return Promise.all(seeded.map(async (s) => ({ ...s, before: await snapshotSession(stub, s) })));
}

/** One stopped, 30-day-old session. */
export async function seedOldSession(stub: Stub, label: string, turns = 3): Promise<SeededSession> {
  const [session] = await seedSessions(stub, [{ label, turns }]);
  return session!;
}

export type SessionSnapshot = {
  groupedRows: number;
  ftsMatches: number;
  messageDigest: string;
  searchIndexState: string | null;
  materializedAt: number | null;
};

export async function snapshotSession(
  stub: Stub,
  { sessionId, token }: { sessionId: string; token: string }
): Promise<SessionSnapshot> {
  return runInDurableObject(stub, async (_instance, state) => {
    const sql = state.storage.sql;
    const grouped = sql
      .exec('SELECT COUNT(*) AS count FROM chat_messages_grouped WHERE session_id = ?', sessionId)
      .one() as { count: number };
    // A MATCH reads the FTS index itself; joining the external-content table by
    // rowid would read the content table and could not see stale index entries.
    const fts = sql
      .exec(
        'SELECT COUNT(*) AS count FROM chat_messages_grouped_fts WHERE chat_messages_grouped_fts MATCH ?',
        token
      )
      .one() as { count: number };
    const contents = sql
      .exec('SELECT id, content FROM chat_messages WHERE session_id = ? ORDER BY id', sessionId)
      .toArray()
      .map((row) => `${String(row.id)}:${String(row.content)}`)
      .join('\n');
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(contents));
    const session = sql
      .exec('SELECT search_index_state, materialized_at FROM chat_sessions WHERE id = ?', sessionId)
      .one() as { search_index_state: string | null; materialized_at: number | null };
    return {
      groupedRows: grouped.count,
      ftsMatches: fts.count,
      messageDigest: Buffer.from(digest).toString('hex'),
      searchIndexState: session.search_index_state,
      materializedAt: session.materialized_at,
    };
  });
}

/**
 * FTS5's consistency check. For an external-content table only the `rank = 1` form
 * compares the index against the content table; without it, a stale entry for a
 * deleted row or a 'delete' issued with the wrong content both pass.
 */
export async function assertFtsIntegrity(stub: Stub): Promise<void> {
  await runInDurableObject(stub, async (_instance, state) => {
    state.storage.sql.exec(
      `INSERT INTO chat_messages_grouped_fts(chat_messages_grouped_fts, rank) VALUES('integrity-check', 1)`
    );
  });
}

export async function searchFinds(
  stub: Stub,
  { sessionId, token }: SeededSession
): Promise<boolean> {
  const found = await runInDurableObject(stub, async (instance) =>
    instance.searchMessages(token, null, null, 5)
  );
  return found.some((r: { sessionId: string }) => r.sessionId === sessionId);
}
