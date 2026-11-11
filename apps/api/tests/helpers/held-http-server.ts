/**
 * A real HTTP server that holds every request until the test answers it, so a test owns the
 * order of events instead of racing wall-clock delays. Pair it with
 * `vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })` to move a deadline exactly
 * between two hops (`.claude/rules/62`: ordering defects need controlled ordering).
 *
 * `nextRequest()` resolves on real socket I/O, which fake timers do not affect.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface HeldRequest {
  url: string;
  headers: IncomingMessage['headers'];
  /** Answers with headers and, unless `holdBody`, the whole body. */
  respond: (status: number, headers?: Record<string, string>, body?: string) => void;
  /** Sends headers and the first chunk now; returns a function that ends the body. */
  respondHoldingBody: (status: number, first: string) => (rest: string) => void;
}

export interface HeldHttpServer {
  base: string;
  /** The next request to arrive (already arrived ones first). */
  nextRequest: () => Promise<HeldRequest>;
  /** Requests received so far. */
  count: () => number;
  close: () => Promise<void>;
}

function held(req: IncomingMessage, res: ServerResponse): HeldRequest {
  return {
    url: req.url ?? '/',
    headers: req.headers,
    respond: (status, headers = {}, body = '') => {
      res.writeHead(status, headers);
      res.end(body);
    },
    respondHoldingBody: (status, first) => {
      res.writeHead(status, { 'content-type': 'text/plain' });
      res.write(first);
      return (rest) => res.end(rest);
    },
  };
}

export async function startHeldHttpServer(): Promise<HeldHttpServer> {
  const arrived: HeldRequest[] = [];
  const waiting: Array<(request: HeldRequest) => void> = [];
  let received = 0;
  const server: Server = createServer((req, res) => {
    received += 1;
    // Drain the request body so the request is complete before the test answers.
    req.resume();
    const request = held(req, res);
    const waiter = waiting.shift();
    if (waiter) waiter(request);
    else arrived.push(request);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    nextRequest: () => {
      const ready = arrived.shift();
      return ready ? Promise.resolve(ready) : new Promise((resolve) => waiting.push(resolve));
    },
    count: () => received,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** Whether `promise` has settled, without waiting on any timer. */
export async function settled(promise: Promise<unknown>): Promise<boolean> {
  let done = false;
  void promise.then(
    () => (done = true),
    () => (done = true)
  );
  // A few macrotask turns let an abort travel through undici and the caller's catch blocks.
  for (let turn = 0; turn < 20 && !done; turn += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  return done;
}
