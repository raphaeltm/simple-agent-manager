/**
 * Transcript pages that end inside a group of tied timestamps.
 *
 * A whole VM-agent batch can share one `created_at`, and two writers can even
 * share a `(created_at, sequence)` pair, so both page cursors have to carry the
 * full `(createdAt, sequence, id)` position. Every request here goes through the
 * real worker (`SELF`), route mounting, session auth, service, and Durable
 * Object SQL — the path the web client pages through.
 */
import { formatMessageCursor } from '@simple-agent-manager/shared';
import { env, SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';

import type { Env } from '../../src/env';
import * as projectDataService from '../../src/services/project-data';
import { createSessionCookieForUser } from '../../src/services/session-factory';

const testEnv = env as unknown as Env;
const RUN = `pagination-ties-${Date.now()}`;
const USER_ID = `${RUN}-user`;
const PROJECT_ID = `${RUN}-proj`;
const NOW = new Date().toISOString();

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

type PageMessage = { id: string; createdAt: number; sequence: number };
type Page = { messages: PageMessage[]; hasMore: boolean };

let sessionCookie: string;
let sessionId: string;

beforeAll(async () => {
  const installationId = `${RUN}-inst`;
  await testEnv.DATABASE.prepare(
    `INSERT INTO users (id, email, name, email_verified, role, status, created_at, updated_at)
     VALUES (?, ?, 'Paging user', 1, 'user', 'active', ?, ?)`
  )
    .bind(USER_ID, `${USER_ID}@example.com`, NOW, NOW)
    .run();
  await testEnv.DATABASE.prepare(
    `INSERT INTO github_installations
       (id, user_id, installation_id, account_type, account_name, created_at, updated_at)
     VALUES (?, ?, ?, 'User', 'acme', ?, ?)`
  )
    .bind(installationId, USER_ID, installationId, NOW, NOW)
    .run();
  await testEnv.DATABASE.prepare(
    `INSERT INTO projects
       (id, user_id, created_by, name, normalized_name, installation_id, repository, created_at, updated_at)
     VALUES (?, ?, ?, 'Paging project', 'paging-project', ?, 'acme/repo', ?, ?)`
  )
    .bind(PROJECT_ID, USER_ID, USER_ID, installationId, NOW, NOW)
    .run();
  await testEnv.DATABASE.prepare(
    `INSERT INTO project_members (project_id, user_id, role, status, invited_by, created_at, updated_at)
     VALUES (?, ?, 'owner', 'active', ?, ?, ?)`
  )
    .bind(PROJECT_ID, USER_ID, USER_ID, NOW, NOW)
    .run();
  sessionCookie = (await createSessionCookieForUser(testEnv, USER_ID)).sessionCookie;

  sessionId = await projectDataService.createSession(testEnv, PROJECT_ID, null, 'Tied messages');
  // Persist in reverse so insertion order cannot stand in for transcript order.
  await projectDataService.persistMessageBatch(
    testEnv,
    PROJECT_ID,
    sessionId,
    [...SEED].reverse().map((row) => ({
      messageId: row.id,
      role: 'assistant',
      content: `content of ${row.id}`,
      toolMetadata: null,
      timestamp: new Date(row.at).toISOString(),
      sequence: row.sequence,
    }))
  );
});

async function getPage(path: string, query: Record<string, string>): Promise<Page> {
  const url = new URL(`https://api.test.example.com/api/projects/${PROJECT_ID}/sessions/${sessionId}${path}`);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  const response = await SELF.fetch(url, { headers: { Cookie: sessionCookie } });
  expect(response.status).toBe(200);
  return (await response.json()) as Page;
}

function cursorOf(message: PageMessage | undefined): string {
  if (!message) throw new Error('Page ended without a message to resume from');
  return formatMessageCursor(message);
}

/** Reads forward page by page, resuming after the last row of each page. */
async function drainForward(path: string): Promise<string[]> {
  const ids: string[] = [];
  let after: string | undefined;
  for (let pages = 0; pages <= TRANSCRIPT.length; pages++) {
    const page = await getPage(path, { limit: '2', ...(after ? { after } : { order: 'asc' }) });
    ids.push(...page.messages.map((message) => message.id));
    if (!page.hasMore) return ids;
    after = cursorOf(page.messages.at(-1));
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
    before = cursorOf(page.messages[0]);
  }
  throw new Error('Backward paging did not terminate');
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
      page = await getPage('', { after: cursorOf(page.messages.at(-1)), limit: '2' });
      ids.push(...page.messages.map((message) => message.id));
    }
    expect(ids).toEqual(TRANSCRIPT.slice(TRANSCRIPT.indexOf('tie-3')));
  });

  it('keeps legacy timestamp cursors exclusive of every tied row', async () => {
    const page = await getPage('/messages', { after: String(T0), order: 'asc', limit: '100' });
    expect(page.messages.map((message) => message.id)).toEqual(TRANSCRIPT.slice(5));
  });
});
