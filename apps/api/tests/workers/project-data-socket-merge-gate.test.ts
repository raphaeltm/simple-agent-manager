/**
 * Chunk merging and browser sockets, through the real stack: browser sockets are opened through
 * `GET /api/projects/:projectId/sessions/ws` with a real session cookie, and reporter chunks
 * arrive through the authenticated workspace callback route.
 *
 * A browser built before chunk merging (#2760) opens sockets without `message-append-v1`:
 * - its project socket (session list) never reads transcript frames, so it must not switch
 *   merging off for the project;
 * - its chat socket ignores `message.append`, so merging stays off for that session, and a
 *   socket that joins while a merged batch is in flight must still end up with the full text.
 */
import { projectDataPorts } from '@simple-agent-manager/project-data/internal/do/ports';
import { CHAT_MESSAGE_RESYNC_CLOSE_CODE } from '@simple-agent-manager/shared';
import { runInDurableObject, SELF } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  chunks,
  contents,
  deliver,
  type Startup,
  startup,
} from './helpers/merge-reporter-workspace';
import { seedSignedInUser } from './helpers/seed-d1';

afterEach(() => vi.restoreAllMocks());

const API = 'https://api.test.example.com';
const TRANSCRIPT_FRAMES = ['message.new', 'messages.batch', 'message.append'];

type Frame = { type: string; payload: Record<string, unknown> };
type Row = { id: string; content: string };

interface BrowserSocket {
  ws: WebSocket;
  frames: Frame[];
  closeCode: () => number | null;
}

async function openSocket(
  f: Startup,
  cookie: string,
  query: { sessionId?: string; capable: boolean }
): Promise<BrowserSocket> {
  const params = new URLSearchParams();
  if (query.sessionId) params.set('sessionId', query.sessionId);
  if (query.capable) params.set('messageAppend', 'message-append-v1');
  const response = await SELF.fetch(`${API}/api/projects/${f.project}/sessions/ws?${params}`, {
    headers: { Upgrade: 'websocket', Cookie: cookie },
  });
  expect(response.status).toBe(101);
  const ws = response.webSocket!;
  ws.accept();
  const frames: Frame[] = [];
  let code: number | null = null;
  ws.addEventListener('message', (event) => {
    frames.push(JSON.parse(event.data as string) as Frame);
  });
  ws.addEventListener('close', (event) => {
    code = event.code;
  });
  return { ws, frames, closeCode: () => code };
}

async function settle(until: () => boolean = () => false): Promise<void> {
  for (let i = 0; i < 40 && !until(); i++) await new Promise((r) => setTimeout(r, 25));
}

function transcriptFrames(socket: BrowserSocket): Frame[] {
  return socket.frames.filter((frame) => TRANSCRIPT_FRAMES.includes(frame.type));
}

async function storedRows(f: Startup, sessionId = f.session): Promise<Row[]> {
  const page = await f.stub.getMessages(sessionId, 1000, null, null, undefined, false, 'asc');
  return page.messages.map(({ id, content }) => ({ id, content }));
}

/**
 * The transcript a pre-#2760 chat view ends with (apps/web at 7bea824b9^): socket rows are added
 * only when their ID is new, `message.append` is an unknown frame, and any close other than 1000
 * triggers a reconnect whose newest-window read replaces rows by ID.
 */
function legacyTranscript(initial: Row[], socket: BrowserSocket, reread: Row[]): Row[] {
  const byId = new Map(initial.map((row) => [row.id, row]));
  for (const frame of socket.frames) {
    const incoming =
      frame.type === 'message.new'
        ? [{ id: String(frame.payload.messageId), content: String(frame.payload.content) }]
        : frame.type === 'messages.batch'
          ? (frame.payload.messages as Row[]).map(({ id, content }) => ({ id, content }))
          : [];
    for (const row of incoming) if (!byId.has(row.id)) byId.set(row.id, row);
  }
  const code = socket.closeCode();
  if (code !== null && code !== 1000) for (const row of reread) byId.set(row.id, row);
  return [...byId.values()];
}

/** The transcript a current chat view builds by applying appends at their offsets. */
function capableTranscript(socket: BrowserSocket): Row[] {
  const byId = new Map<string, Row>();
  for (const frame of socket.frames) {
    if (frame.type === 'messages.batch')
      for (const { id, content } of frame.payload.messages as Row[]) byId.set(id, { id, content });
    if (frame.type === 'message.append') {
      const row = byId.get(String(frame.payload.id))!;
      expect(row.content.length).toBe(frame.payload.offset);
      row.content += String(frame.payload.content);
    }
  }
  return [...byId.values()];
}

async function signedIn(f: Startup): Promise<string> {
  return seedSignedInUser(f.user);
}

describe('browser sockets and chunk merging', () => {
  it('a legacy project socket no longer switches merging off, and receives no transcript frames', async () => {
    const f = await startup();
    const cookie = await signedIn(f);
    await deliver(f, chunks(f, ['one ', 'two ']));
    // Admitted mid-reply: neither the merge decision nor the admission may end the open row.
    const project = await openSocket(f, cookie, { capable: false });
    await deliver(f, chunks(f, ['three ', 'four'], 3, 'b'));

    expect(await contents(f)).toEqual(['one two three four']);
    // Liveness: the project socket is open and still receives session lifecycle frames.
    await f.stub.updateSessionTopic(f.session, 'Renamed');
    await settle(() => project.frames.some((frame) => frame.type === 'session.updated'));
    expect(project.frames.map((frame) => frame.type)).toContain('session.updated');
    expect(transcriptFrames(project)).toEqual([]);
  });

  it('a capable project socket receives no transcript frames either', async () => {
    const f = await startup();
    const project = await openSocket(f, await signedIn(f), { capable: true });
    await deliver(f, chunks(f, ['one ', 'two']));
    await f.stub.updateSessionTopic(f.session, 'Renamed');
    await settle(() => project.frames.some((frame) => frame.type === 'session.updated'));
    expect(project.frames.map((frame) => frame.type)).toContain('session.updated');
    expect(transcriptFrames(project)).toEqual([]);
  });

  it('a legacy chat socket switches merging off for its own session only', async () => {
    const f = await startup();
    const cookie = await signedIn(f);
    const other = await f.stub.createSession(f.workspace, 'Other session');
    const legacy = await openSocket(f, cookie, { sessionId: f.session, capable: false });

    await deliver(f, chunks(f, ['one ', 'two ']));
    await deliver(f, chunks(f, ['three ', 'four'], 3, 'b'));
    const source = {
      workspaceId: f.workspace,
      callbackGeneration: null,
      outboxIncarnation: f.incarnation,
    };
    const otherChunks = ['five ', 'six'].map((content, index) => ({
      messageId: `${f.prefix}-other-${index}`,
      role: 'assistant',
      content,
      toolMetadata: null,
      timestamp: f.now,
      sequence: 101 + index,
    }));
    await f.stub.persistMessageBatch(other, otherChunks, source);

    expect(await contents(f)).toEqual(['one ', 'two ', 'three ', 'four']);
    expect((await storedRows(f, other)).map((row) => row.content)).toEqual(['five six']);
    await settle(() => transcriptFrames(legacy).length >= 2);
    expect(legacy.frames.map((frame) => frame.type)).not.toContain('message.append');
    expect(legacyTranscript([], legacy, []).map((row) => row.content)).toEqual([
      'one ',
      'two ',
      'three ',
      'four',
    ]);
  });

  it('a capable chat socket still receives appends and rebuilds the stored rows', async () => {
    const f = await startup();
    const chat = await openSocket(f, await signedIn(f), { sessionId: f.session, capable: true });

    await deliver(f, chunks(f, ['one ', 'two ']));
    await deliver(f, chunks(f, ['three ', 'four'], 3, 'b'));
    await settle(() => chat.frames.some((frame) => frame.type === 'message.append'));

    expect(chat.frames.map((frame) => frame.type)).toContain('message.append');
    expect(capableTranscript(chat)).toEqual(await storedRows(f));
    expect(chat.closeCode()).toBeNull();
  });

  it('a legacy chat socket admitted mid-batch gets no append and still ends with the full text', async () => {
    const f = await startup();
    const cookie = await signedIn(f);
    await deliver(f, chunks(f, ['one ', 'two ']));
    // The tab read the transcript, then opened its socket while the next batch was in flight.
    const loaded = await storedRows(f);
    expect(loaded.map((row) => row.content)).toEqual(['one two ']);

    // An armed idle cleanup makes every batch await `recalculateAlarm` after its transaction
    // and before its broadcasts. Hold the next batch at exactly that point.
    await f.stub.scheduleIdleCleanup(f.session, f.workspace, null);
    // The test and the object signal through plain flags, each waiting on its own timers: a
    // promise resolved across the boundary would resume in the other side's I/O context.
    const hold = { reached: false, released: false };
    await runInDurableObject(f.stub, (instance) => {
      const target = instance as unknown as { recalculateAlarm: () => Promise<void> };
      const original = target.recalculateAlarm.bind(instance);
      let first = true;
      target.recalculateAlarm = async () => {
        if (first) {
          first = false;
          hold.reached = true;
          while (!hold.released) await new Promise((resolve) => setTimeout(resolve, 5));
        }
        return original();
      };
    });

    const inFlight = deliver(f, chunks(f, ['three ', 'four'], 3, 'b'));
    await settle(() => hold.reached);
    expect(hold.reached).toBe(true);
    // Committed already: the second batch was appended to the open row.
    expect((await storedRows(f)).map((row) => row.content)).toEqual(['one two three four']);
    const legacy = await openSocket(f, cookie, { sessionId: f.session, capable: false });
    hold.released = true;
    await inFlight;
    await settle(() => legacy.closeCode() !== null);

    expect(legacy.frames.map((frame) => frame.type)).not.toContain('message.append');
    expect(legacy.closeCode()).toBe(CHAT_MESSAGE_RESYNC_CLOSE_CODE);
    const reread = await storedRows(f);
    expect(legacyTranscript(loaded, legacy, reread)).toEqual(reread);
    expect(reread.map((row) => row.content)).toEqual(['one two three four']);

    // The reconnected socket keeps merging off for this session.
    const reconnected = await openSocket(f, cookie, { sessionId: f.session, capable: false });
    await deliver(f, chunks(f, ['five ', 'six'], 5, 'c'));
    expect(await contents(f)).toEqual(['one two three four', 'five ', 'six']);
    expect(reconnected.closeCode()).toBeNull();
  });

  it('with merging off, every socket keeps individual rows exactly as before', async () => {
    const f = await startup();
    vi.mocked(projectDataPorts().operations.messageMergeConfig!).mockResolvedValue({
      enabled: false,
      maxRowBytes: 65536,
      recentIds: 200,
    });
    const cookie = await signedIn(f);
    const capable = await openSocket(f, cookie, { sessionId: f.session, capable: true });
    const legacy = await openSocket(f, cookie, { sessionId: f.session, capable: false });

    await deliver(f, chunks(f, ['one ', 'two ']));
    await deliver(f, chunks(f, ['three ', 'four'], 3, 'b'));
    await settle(
      () => transcriptFrames(legacy).length >= 2 && transcriptFrames(capable).length >= 2
    );

    const stored = await storedRows(f);
    expect(stored.map((row) => row.content)).toEqual(['one ', 'two ', 'three ', 'four']);
    for (const socket of [capable, legacy]) {
      expect(socket.frames.map((frame) => frame.type)).not.toContain('message.append');
      expect(legacyTranscript([], socket, [])).toEqual(stored);
      expect(socket.closeCode()).toBeNull();
    }
  });
});
