/**
 * Failure isolation in browser-socket broadcast. The behaviour itself (who receives what, and
 * the merge gate) is covered end to end in apps/api/tests/workers/project-data-socket-merge-gate;
 * these cases cover socket failures workerd does not produce on demand.
 */
import {
  CHAT_MESSAGE_APPEND_CAPABILITY,
  CHAT_MESSAGE_RESYNC_CLOSE_CODE,
} from '@simple-agent-manager/shared';
import { describe, expect, it, vi } from 'vitest';

import {
  broadcastToBrowserSockets,
  closeIfAccessRevoked,
  closeQuietly,
  countLegacySockets,
} from '../../src/do/session-sockets';

const SESSION = '11111111-2222-3333-4444-555555555555';

interface FakeSocket {
  readyState: number;
  tags: string[] | 'throws';
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  deserializeAttachment: () => unknown;
}

function socket(tags: string[] | 'throws', opts: { sendThrows?: boolean } = {}): FakeSocket {
  const ws: FakeSocket = {
    readyState: WebSocket.OPEN,
    tags,
    deserializeAttachment: () => null,
    send: vi.fn(() => {
      if (opts.sendThrows) throw new Error('socket closed');
    }),
    close: vi.fn(() => {
      ws.readyState = WebSocket.CLOSING;
    }),
  };
  return ws;
}

function context(sockets: FakeSocket[]) {
  return {
    getWebSockets: (tag?: string) =>
      sockets.filter((ws) => !tag || (Array.isArray(ws.tags) && ws.tags.includes(tag))),
    getTags: (ws: FakeSocket) => {
      if (ws.tags === 'throws') throw new Error('socket is gone');
      return ws.tags;
    },
  } as unknown as DurableObjectState;
}

const session = [`session:${SESSION}`];
const capable = [...session, CHAT_MESSAGE_APPEND_CAPABILITY];

describe('broadcastToBrowserSockets failure isolation', () => {
  it('a socket whose send throws does not stop delivery to the others', () => {
    const broken = socket(capable, { sendThrows: true });
    const healthy = socket(capable);
    broadcastToBrowserSockets(context([broken, healthy]), 'message.append', {}, SESSION);
    expect(broken.send).toHaveBeenCalledOnce();
    expect(healthy.send).toHaveBeenCalledOnce();
  });

  it('a socket whose tags cannot be read is skipped without throwing', () => {
    const gone = socket('throws');
    const project = socket([]);
    expect(() =>
      broadcastToBrowserSockets(context([gone, project]), 'session.updated', {}, SESSION)
    ).not.toThrow();
    expect(project.send).toHaveBeenCalledOnce();
  });

  it('closes every legacy chat socket once, even across repeated appends', () => {
    const first = socket(session);
    const second = socket(session);
    const current = socket(capable);
    const ctx = context([first, second, current]);
    broadcastToBrowserSockets(ctx, 'message.append', {}, SESSION);
    broadcastToBrowserSockets(ctx, 'message.append', {}, SESSION);
    for (const legacy of [first, second]) {
      expect(legacy.send).not.toHaveBeenCalled();
      expect(legacy.close).toHaveBeenCalledOnce();
      expect(legacy.close).toHaveBeenCalledWith(CHAT_MESSAGE_RESYNC_CLOSE_CODE, expect.any(String));
    }
    expect(current.send).toHaveBeenCalledTimes(2);
  });

  it('a close that throws neither escapes nor blocks the next socket', () => {
    const throwing = socket(session);
    throwing.close.mockImplementation(() => {
      throw new Error('already closed');
    });
    const next = socket(session);
    expect(() =>
      broadcastToBrowserSockets(context([throwing, next]), 'message.append', {}, SESSION)
    ).not.toThrow();
    expect(next.close).toHaveBeenCalledOnce();
    expect(() => closeQuietly(throwing as unknown as WebSocket)).not.toThrow();
  });
});

describe('countLegacySockets', () => {
  it('counts open sockets without the capability, by scope', () => {
    const closing = socket(session);
    closing.readyState = WebSocket.CLOSING;
    const other = socket(['session:99999999-2222-3333-4444-555555555555']);
    expect(countLegacySockets(context([closing, other, socket(capable)]), SESSION)).toEqual({
      session: 0,
      project: 0,
    });
    expect(
      countLegacySockets(
        context([closing, socket(session), socket([]), socket([CHAT_MESSAGE_APPEND_CAPABILITY])]),
        SESSION
      )
    ).toEqual({ session: 1, project: 1 });
  });
});

describe('post-admission access verification', () => {
  function pendingSocket() {
    const ws = socket([`session:${SESSION}`, 'actor:member']);
    let attachment: unknown = { accessPending: true };
    return Object.assign(ws, {
      deserializeAttachment: () => attachment,
      serializeAttachment: (value: unknown) => {
        attachment = value;
      },
    });
  }
  function database(read: () => Promise<unknown>) {
    return { prepare: () => ({ bind: () => ({ first: read }) }) } as unknown as D1Database;
  }
  it('withholds every broadcast while the read is pending and resumes only after proof', async () => {
    const pending = pendingSocket();
    const current = socket([`session:${SESSION}`]);
    const ctx = context([pending, current]);
    let release!: (value: unknown) => void;
    const read = new Promise((resolve) => {
      release = resolve;
    });
    const check = closeIfAccessRevoked(
      database(() => read),
      'project',
      'member',
      pending as unknown as WebSocket
    );
    for (const [type, scope] of [
      ['message.new', SESSION],
      ['session.updated', SESSION],
      ['project.updated', undefined],
    ] as const) {
      broadcastToBrowserSockets(ctx, type, {}, scope);
    }
    expect(current.send).toHaveBeenCalledTimes(3);
    expect(pending.send).not.toHaveBeenCalled();
    release({ ok: 1 });
    await check;
    broadcastToBrowserSockets(ctx, 'message.new', {}, SESSION);
    expect(pending.send).toHaveBeenCalledOnce();
  });
  it('closes a failed lookup with a retryable code and a denied lookup with4403', async () => {
    const failed = pendingSocket();
    await closeIfAccessRevoked(
      database(async () => {
        throw new Error('D1 unavailable');
      }),
      'p',
      'u',
      failed as unknown as WebSocket
    );
    expect(failed.close).toHaveBeenCalledWith(1013, expect.any(String));
    const denied = pendingSocket();
    await closeIfAccessRevoked(
      database(async () => null),
      'p',
      'u',
      denied as unknown as WebSocket
    );
    expect(denied.close).toHaveBeenCalledWith(4403, expect.any(String));
  });
  it('a revocation close during the read wins over later positive proof', async () => {
    const pending = pendingSocket();
    let release!: (value: unknown) => void;
    const check = closeIfAccessRevoked(
      database(
        () =>
          new Promise((resolve) => {
            release = resolve;
          })
      ),
      'p',
      'u',
      pending as unknown as WebSocket
    );
    pending.close();
    release({ ok: 1 });
    await check;
    expect(pending.deserializeAttachment()).toEqual({ accessPending: true });
    broadcastToBrowserSockets(context([pending]), 'message.new', {}, SESSION);
    expect(pending.send).not.toHaveBeenCalled();
  });
});
