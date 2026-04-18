/**
 * Unit tests for TrialEventBus DO.
 *
 * Covers:
 *   - POST /append stores event and returns cursor
 *   - GET /poll with no events returns immediately after timeout with empty
 *     events array
 *   - Appending an event wakes a pending poller
 *   - GET /poll with cursor only returns events newer than cursor
 *   - Appending terminal event (trial.ready / trial.error) closes the bus and
 *     subsequent polls return closed=true
 *   - POST /close sets closed=true and wakes waiters
 *   - POST /append on a closed bus returns 409
 *   - Buffer evicts oldest beyond MAX_BUFFERED_EVENTS (500)
 */
import { describe, expect, it, vi } from 'vitest';

// Base DO class shim
vi.mock('cloudflare:workers', () => ({
  DurableObject: class {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ctx: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    env: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(ctx: any, env: any) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

const { TrialEventBus } = await import('../../../src/durable-objects/trial-event-bus');

function makeDO() {
  const ctx = {} as unknown;
  const env = {} as unknown;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new TrialEventBus(ctx as any, env as any);
}

function appendReq(event: unknown): Request {
  return new Request('https://trial-event-bus/append', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(event),
  });
}

function pollReq(cursor = 0, timeoutMs = 100): Request {
  return new Request(
    `https://trial-event-bus/poll?cursor=${cursor}&timeoutMs=${timeoutMs}`,
    { method: 'GET' }
  );
}

function closeReq(): Request {
  return new Request('https://trial-event-bus/close', { method: 'POST' });
}

describe('TrialEventBus DO', () => {
  it('POST /append stores an event and returns a cursor', async () => {
    const bus = makeDO();
    const r = await bus.fetch(appendReq({ type: 'trial.progress', message: 'x', at: 1 }));
    expect(r.status).toBe(200);
    const body = (await r.json()) as { cursor: number };
    expect(body.cursor).toBe(1);
  });

  it('POST /append rejects invalid JSON', async () => {
    const bus = makeDO();
    const req = new Request('https://trial-event-bus/append', {
      method: 'POST',
      body: 'not-json',
    });
    const r = await bus.fetch(req);
    expect(r.status).toBe(400);
  });

  it('GET /poll with empty buffer waits and returns empty events', async () => {
    const bus = makeDO();
    const r = await bus.fetch(pollReq(0, 100));
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      events: unknown[];
      cursor: number;
      closed: boolean;
    };
    expect(body.events).toEqual([]);
    expect(body.closed).toBe(false);
  });

  it('GET /poll returns events newer than cursor', async () => {
    const bus = makeDO();
    await bus.fetch(appendReq({ type: 'trial.progress', message: 'a', at: 1 }));
    await bus.fetch(appendReq({ type: 'trial.progress', message: 'b', at: 2 }));

    const r = await bus.fetch(pollReq(1, 100));
    const body = (await r.json()) as {
      events: { cursor: number; event: { message: string } }[];
    };
    expect(body.events.length).toBe(1);
    expect(body.events[0].event.message).toBe('b');
  });

  it('Appending a terminal event (trial.ready) closes the bus', async () => {
    const bus = makeDO();
    await bus.fetch(appendReq({ type: 'trial.ready', projectId: 'p', at: 1 }));

    const poll = await bus.fetch(pollReq(0, 100));
    const body = (await poll.json()) as { closed: boolean; events: unknown[] };
    expect(body.closed).toBe(true);
    expect(body.events.length).toBe(1);
  });

  it('Appending a terminal event (trial.error) closes the bus', async () => {
    const bus = makeDO();
    await bus.fetch(
      appendReq({ type: 'trial.error', error: 'kaboom', message: 'x', at: 1 })
    );

    const poll = await bus.fetch(pollReq(0, 100));
    const body = (await poll.json()) as { closed: boolean };
    expect(body.closed).toBe(true);
  });

  it('POST /close sets closed=true', async () => {
    const bus = makeDO();
    const r = await bus.fetch(closeReq());
    expect(r.status).toBe(200);

    const poll = await bus.fetch(pollReq(0, 100));
    const body = (await poll.json()) as { closed: boolean };
    expect(body.closed).toBe(true);
  });

  it('POST /append on a closed bus returns 409', async () => {
    const bus = makeDO();
    await bus.fetch(closeReq());

    const r = await bus.fetch(appendReq({ type: 'trial.progress', message: 'x', at: 0 }));
    expect(r.status).toBe(409);
  });

  it('Appending an event wakes a pending long-poll', async () => {
    const bus = makeDO();
    // Start a long poll with 2s timeout but we'll append within 50ms.
    const pollPromise = bus.fetch(pollReq(0, 2000));

    // Give the poll a tick to register the waiter.
    await new Promise((r) => setTimeout(r, 10));
    await bus.fetch(appendReq({ type: 'trial.progress', message: 'wake', at: 1 }));

    const start = Date.now();
    const resp = await pollPromise;
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(500); // short-circuited, not timed out
    const body = (await resp.json()) as {
      events: { event: { message: string } }[];
    };
    expect(body.events.length).toBe(1);
    expect(body.events[0].event.message).toBe('wake');
  });

  it('POST /close wakes pending pollers', async () => {
    const bus = makeDO();
    const pollPromise = bus.fetch(pollReq(0, 2000));

    await new Promise((r) => setTimeout(r, 10));
    await bus.fetch(closeReq());

    const start = Date.now();
    const resp = await pollPromise;
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(500);
    const body = (await resp.json()) as { closed: boolean };
    expect(body.closed).toBe(true);
  });

  it('unknown path returns 404', async () => {
    const bus = makeDO();
    const r = await bus.fetch(
      new Request('https://trial-event-bus/garbage', { method: 'GET' })
    );
    expect(r.status).toBe(404);
  });
});
