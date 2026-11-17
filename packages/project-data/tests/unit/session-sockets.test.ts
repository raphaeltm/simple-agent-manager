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
  closeQuietly,
  countLegacySockets,
} from '../../src/do/session-sockets';

const SESSION = '11111111-2222-3333-4444-555555555555';
const PROJECT = 'project-1';

interface FakeSocket {
  readyState: number;
  tags: string[] | 'throws';
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  deserializeAttachment: ReturnType<typeof vi.fn>;
}

function socket(
  tags: string[] | 'throws',
  opts: { expiresAt?: number; sendThrows?: boolean } = {}
): FakeSocket {
  const ws: FakeSocket = {
    readyState: WebSocket.OPEN,
    tags,
    send: vi.fn(() => {
      if (opts.sendThrows) throw new Error('socket closed');
    }),
    close: vi.fn(() => {
      ws.readyState = WebSocket.CLOSING;
    }),
    deserializeAttachment: vi.fn(() => ({
      version: 1,
      actorId: 'user-1',
      projectId: PROJECT,
      sessionId: Array.isArray(tags)
        ? (tags.find((tag) => tag.startsWith('session:'))?.slice('session:'.length) ?? null)
        : null,
      capability: 'project:read',
      expiresAt: opts.expiresAt ?? 2_000_000_000_000,
    })),
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
    broadcastToBrowserSockets(context([broken, healthy]), PROJECT, 'message.append', {}, SESSION);
    expect(broken.send).toHaveBeenCalledOnce();
    expect(healthy.send).toHaveBeenCalledOnce();
  });

  it('a socket whose tags cannot be read is skipped without throwing', () => {
    const gone = socket('throws');
    const project = socket([]);
    expect(() =>
      broadcastToBrowserSockets(context([gone, project]), PROJECT, 'session.updated', {}, SESSION)
    ).not.toThrow();
    expect(project.send).toHaveBeenCalledOnce();
  });

  it('closes expired authority before broadcasting while preserving active delivery', () => {
    const expired = socket([], { expiresAt: 1 });
    const active = socket([]);

    broadcastToBrowserSockets(context([expired, active]), PROJECT, 'session.updated', {});

    expect(expired.close).toHaveBeenCalledWith(4403, 'authorization expired');
    expect(expired.send).not.toHaveBeenCalled();
    expect(active.send).toHaveBeenCalledOnce();
  });

  it('closes every legacy chat socket once, even across repeated appends', () => {
    const first = socket(session);
    const second = socket(session);
    const current = socket(capable);
    const ctx = context([first, second, current]);
    broadcastToBrowserSockets(ctx, PROJECT, 'message.append', {}, SESSION);
    broadcastToBrowserSockets(ctx, PROJECT, 'message.append', {}, SESSION);
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
      broadcastToBrowserSockets(context([throwing, next]), PROJECT, 'message.append', {}, SESSION)
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
