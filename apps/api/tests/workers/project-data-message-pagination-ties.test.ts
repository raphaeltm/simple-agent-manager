/**
 * Transcript pages that end inside a group of tied timestamps.
 *
 * A whole VM-agent batch can share one `created_at`, and two writers can even
 * share a `(created_at, sequence)` pair, so both page cursors have to carry the
 * full `(createdAt, sequence, id)` position.
 *
 * Root sessions are read through the real worker (`SELF`): route mounting,
 * session auth, service, and Durable Object SQL — the path the web client
 * pages through. Archived sessions are read through the service, which routes
 * to the archive shard only while archive sharding is enabled.
 */
import { formatMessageCursor, type MessagePosition } from '@simple-agent-manager/shared';
import { env, SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';

import type { Env } from '../../src/env';
import { runProjectDataArchiveSharding } from '../../src/scheduled/project-data-archive-sharding';
import * as projectDataService from '../../src/services/project-data';
import { createSessionCookieForUser } from '../../src/services/session-factory';
import {
  isolateSweepFixture,
  projectDataStub,
  readLocation,
  withArchiveEnv,
} from './helpers/archive-fixtures';
import { seedInstallation, seedProject } from './helpers/seed-d1';

const testEnv = env as unknown as Env;
const RUN = `pagination-ties-${Date.now()}`;
const USER_ID = `${RUN}-user`;
const INSTALLATION_ID = `${RUN}-inst`;
const PROJECT_ID = `${RUN}-proj`;
const ARCHIVED_PROJECT_ID = `${RUN}-archived`;

const T0 = Date.parse('2026-09-25T10:00:00.000Z');
const T1 = T0 + 1_000;
const T2 = T0 + 2_000;

/**
 * Nine rows in transcript order. With two rows per page, boundaries fall after
 * `tie-2` and `tie-4` (inside the five-row T0 group) and between `dup-a` and
 * `dup-b`, which share both timestamp and sequence and differ only by id.
 */
const SEED = [
  ...[1, 2, 3, 4, 5].map((sequence) => ({ id: `tie-${sequence}`, at: T0, sequence })),
  { id: 'dup-a', at: T1, sequence: 6 },
  { id: 'dup-b', at: T1, sequence: 6 },
  { id: 'late-1', at: T2, sequence: 7 },
  { id: 'late-2', at: T2, sequence: 8 },
];
const TRANSCRIPT = SEED.map((row) => row.id);

/**
 * Twenty archived rows, three per timestamp, stored in four-row chunks and read
 * five rows per page. The three periods never align, so page edges land inside
 * tie groups that straddle chunk edges in both directions.
 */
const ARCHIVED_SEED = Array.from({ length: 20 }, (_, index) => ({
  id: `archived-${String(index).padStart(2, '0')}`,
  at: T0 + Math.floor(index / 3) * 1_000,
  sequence: index + 1,
}));
const ARCHIVED_TRANSCRIPT = ARCHIVED_SEED.map((row) => row.id);

const ARCHIVE_ENV = {
  PROJECT_DATA_ARCHIVE_SHARDING_ENABLED: 'true',
  PROJECT_DATA_ARCHIVE_GLOBAL_SWEEP_ENABLED: 'true',
  PROJECT_DATA_ARCHIVE_COMPACT_ENABLED: 'true',
  PROJECT_DATA_ARCHIVE_SESSION_GRACE_MS: '1',
  PROJECT_DATA_ARCHIVE_GLOBAL_SWEEP_INTERVAL_MS: '1',
  PROJECT_DATA_ARCHIVE_SWEEP_PROJECTS: '1',
  PROJECT_DATA_ARCHIVE_SWEEP_SESSIONS: '1',
  PROJECT_DATA_ARCHIVE_SWEEP_MESSAGE_BUDGET: '1000',
  PROJECT_DATA_ARCHIVE_SWEEP_UNIT_OVERHEAD_PERCENT: '100',
  PROJECT_DATA_ARCHIVE_WRITE_ESTIMATE_FACTOR: '2',
  PROJECT_DATA_ARCHIVE_DAILY_WRITE_BUDGET: '800000',
  PROJECT_DATA_ARCHIVE_CHUNK_ROWS: '4',
};

type SeedRow = { id: string; at: number; sequence: number };
type PageMessage = { id: string; createdAt: number; sequence: number };
type Page = { messages: PageMessage[]; hasMore: boolean };

let sessionCookie: string;
let sessionId: string;

function toBatch(rows: SeedRow[]) {
  // Persist in reverse so insertion order cannot stand in for transcript order.
  return [...rows].reverse().map((row) => ({
    messageId: row.id,
    role: 'assistant',
    content: `content of ${row.id}`,
    toolMetadata: null,
    timestamp: new Date(row.at).toISOString(),
    sequence: row.sequence,
  }));
}

beforeAll(async () => {
  const now = new Date().toISOString();
  await testEnv.DATABASE.prepare(
    `INSERT INTO users (id, email, name, email_verified, role, status, created_at, updated_at)
     VALUES (?, ?, 'Paging user', 1, 'user', 'active', ?, ?)`
  )
    .bind(USER_ID, `${USER_ID}@example.com`, now, now)
    .run();
  await seedInstallation(INSTALLATION_ID, USER_ID);
  await seedProject(PROJECT_ID, USER_ID, INSTALLATION_ID);
  await seedProject(ARCHIVED_PROJECT_ID, USER_ID, INSTALLATION_ID);
  sessionCookie = (await createSessionCookieForUser(testEnv, USER_ID)).sessionCookie;

  sessionId = await projectDataService.createSession(testEnv, PROJECT_ID, null, 'Tied messages');
  await projectDataService.persistMessageBatch(testEnv, PROJECT_ID, sessionId, toBatch(SEED));
});

async function getPage(path: string, query: Record<string, string>): Promise<Page> {
  const url = new URL(
    `https://api.test.example.com/api/projects/${PROJECT_ID}/sessions/${sessionId}${path}`
  );
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  const response = await SELF.fetch(url, { headers: { Cookie: sessionCookie } });
  expect(response.status).toBe(200);
  return (await response.json()) as Page;
}

function edgePosition(message: PageMessage | Record<string, unknown> | undefined): MessagePosition {
  if (!message) throw new Error('Page ended without a message to resume from');
  return {
    createdAt: Number(message.createdAt),
    sequence: Number(message.sequence),
    id: String(message.id),
  };
}

/** Reads forward page by page, resuming after the last row of each page. */
async function drainForward(path: string): Promise<string[]> {
  const ids: string[] = [];
  let after: string | undefined;
  for (let pages = 0; pages <= TRANSCRIPT.length; pages++) {
    const page = await getPage(path, { limit: '2', ...(after ? { after } : { order: 'asc' }) });
    ids.push(...page.messages.map((message) => message.id));
    if (!page.hasMore) return ids;
    after = formatMessageCursor(edgePosition(page.messages.at(-1)));
  }
  throw new Error('Forward paging did not terminate');
}

/** Reads backward page by page, resuming before the first row of each page. */
async function drainBackward(): Promise<string[]> {
  const ids: string[] = [];
  let before: string | undefined;
  for (let pages = 0; pages <= TRANSCRIPT.length; pages++) {
    const page = await getPage('/messages', { limit: '2', ...(before ? { before } : {}) });
    ids.unshift(...page.messages.map((message) => message.id));
    if (!page.hasMore) return ids;
    before = formatMessageCursor(edgePosition(page.messages[0]));
  }
  throw new Error('Backward paging did not terminate');
}

/** Reads an archived transcript five rows per page through the service's exact-read routing. */
async function drainArchived(archivedSessionId: string, direction: 'forward' | 'backward') {
  const ids: string[] = [];
  let cursor: MessagePosition | null = null;
  const forward = direction === 'forward';
  for (let pages = 0; pages <= ARCHIVED_TRANSCRIPT.length; pages++) {
    const page = await projectDataService.getMessages(
      testEnv,
      ARCHIVED_PROJECT_ID,
      archivedSessionId,
      5,
      forward ? null : cursor,
      forward ? cursor : null,
      undefined,
      false,
      forward ? 'asc' : 'desc'
    );
    const pageIds = page.messages.map((message) => String(message.id));
    if (forward) ids.push(...pageIds);
    else ids.unshift(...pageIds);
    if (!page.hasMore) return ids;
    cursor = edgePosition(forward ? page.messages.at(-1) : page.messages[0]);
  }
  throw new Error(`Archived ${direction} paging did not terminate`);
}

describe('message pagination across tied timestamps', () => {
  it('returns every message exactly once reading forward through the message list', async () => {
    expect(await drainForward('/messages')).toEqual(TRANSCRIPT);
  });

  it('returns every message exactly once reading backward through the message list', async () => {
    expect(await drainBackward()).toEqual(TRANSCRIPT);
  });

  it('drains a session-detail refresh forward from an exact cursor', async () => {
    const after = formatMessageCursor({ createdAt: T0, sequence: 2, id: 'tie-2' });
    const ids: string[] = [];
    let page = await getPage('', { after, limit: '2' });
    ids.push(...page.messages.map((message) => message.id));
    while (page.hasMore) {
      page = await getPage('', {
        after: formatMessageCursor(edgePosition(page.messages.at(-1))),
        limit: '2',
      });
      ids.push(...page.messages.map((message) => message.id));
    }
    expect(ids).toEqual(TRANSCRIPT.slice(TRANSCRIPT.indexOf('tie-3')));
  });

  it('keeps legacy timestamp cursors exclusive of every tied row', async () => {
    const page = await getPage('/messages', { after: String(T0), order: 'asc', limit: '100' });
    expect(page.messages.map((message) => message.id)).toEqual(TRANSCRIPT.slice(5));
  });

  it('reads an archived transcript whose page and chunk edges split tie groups', async () => {
    const source = projectDataStub(ARCHIVED_PROJECT_ID);
    await source.ensureProjectId(ARCHIVED_PROJECT_ID);
    const archivedSessionId = await source.createSession(null, 'Archived ties');
    await source.persistMessageBatch(archivedSessionId, toBatch(ARCHIVED_SEED));
    await source.stopSession(archivedSessionId);
    await source.runSummarySyncForTest();
    await isolateSweepFixture(ARCHIVED_PROJECT_ID, { clearCadence: true });

    await withArchiveEnv(ARCHIVE_ENV, async () => {
      const stats = await runProjectDataArchiveSharding(testEnv, new Date(Date.now() + 60_000));
      expect(stats).toMatchObject({ migrated: 1, failed: 0 });
      expect(await readLocation(ARCHIVED_PROJECT_ID, archivedSessionId)).toMatchObject({
        location_state: 'archive_shard',
      });
      expect(await source.getMessageCount(archivedSessionId)).toBe(0);

      expect(await drainArchived(archivedSessionId, 'forward')).toEqual(ARCHIVED_TRANSCRIPT);
      expect(await drainArchived(archivedSessionId, 'backward')).toEqual(ARCHIVED_TRANSCRIPT);
    });
  });
});
