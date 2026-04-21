/**
 * TrialEventBus — per-trial Durable Object that buffers `TrialEvent`s and
 * supports long-poll subscription for the SSE endpoint.
 *
 * Keyed by trialId (`env.TRIAL_EVENT_BUS.idFromName(trialId)`). One instance
 * per active trial.
 *
 * Storage model: events are held IN-MEMORY only — the trial lifetime is short
 * (<= TRIAL_WORKSPACE_TTL_MS, default 20 min) and the SSE endpoint's long-poll
 * loop reconnects on DO eviction. Persisting every token would multiply DO
 * storage writes without any recovery benefit for disposable anonymous trials.
 *
 * Methods (invoked over HTTP from the Worker):
 *   POST /append   body: TrialEvent   -> { cursor }      append a single event
 *   GET  /poll     ?cursor=&timeoutMs= -> { events, cursor, closed }
 *   POST /close                         mark the trial stream as finished
 *
 * Close semantics: once `/close` is called (after trial.error, or when the
 * discovery agent session ends), subsequent `/poll` calls return
 * `closed: true` and the SSE endpoint finishes the response stream.
 * `trial.ready` is NOT terminal — the discovery agent continues producing
 * knowledge and idea events after the workspace is provisioned.
 */

import type { TrialEvent } from '@simple-agent-manager/shared';
import { DurableObject } from 'cloudflare:workers';

import type { Env } from '../env';
import { log } from '../lib/logger';

interface BufferedEvent {
  cursor: number;
  event: TrialEvent;
}

interface Waiter {
  resolve: () => void;
  timer: ReturnType<typeof setTimeout>;
}

const DEFAULT_POLL_TIMEOUT_MS = 15_000;
const MAX_POLL_TIMEOUT_MS = 60_000;
const MAX_BUFFERED_EVENTS = 500;

export class TrialEventBus extends DurableObject<Env> {
  private buffer: BufferedEvent[] = [];
  private nextCursor = 1;
  private closed = false;
  private waiters: Set<Waiter> = new Set();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    if (req.method === 'POST' && path === '/append') {
      return this.handleAppend(req);
    }
    if (req.method === 'GET' && path === '/poll') {
      return this.handlePoll(url);
    }
    if (req.method === 'POST' && path === '/close') {
      return this.handleClose();
    }
    return new Response('not_found', { status: 404 });
  }

  // -------------------------------------------------------------------------
  // Append
  // -------------------------------------------------------------------------

  private async handleAppend(req: Request): Promise<Response> {
    log.info('trial_event_bus.handleAppend.enter', {
      closed: this.closed,
      bufferLen: this.buffer.length,
    });
    if (this.closed) {
      log.warn('trial_event_bus.handleAppend.rejected_closed', {});
      return new Response(
        JSON.stringify({ error: 'closed' }),
        { status: 409, headers: { 'content-type': 'application/json' } }
      );
    }
    let event: TrialEvent;
    try {
      event = (await req.json()) as TrialEvent;
    } catch {
      return new Response('bad_json', { status: 400 });
    }
    const cursor = this.nextCursor++;
    this.buffer.push({ cursor, event });
    log.info('trial_event_bus.handleAppend.stored', {
      cursor,
      type: event.type,
      waiters: this.waiters.size,
    });
    if (this.buffer.length > MAX_BUFFERED_EVENTS) {
      // Drop oldest events — SSE consumers MUST keep up.
      this.buffer.splice(0, this.buffer.length - MAX_BUFFERED_EVENTS);
    }

    // Auto-close only on hard-terminal events. `trial.ready` is a milestone
    // (workspace provisioned) but the discovery agent continues producing
    // `trial.knowledge` and `trial.idea` events afterward — closing here
    // would reject those late-arriving events with 409.
    if (event.type === 'trial.error') {
      this.closed = true;
    }

    this.wakeWaiters();
    return Response.json({ cursor });
  }

  // -------------------------------------------------------------------------
  // Poll
  // -------------------------------------------------------------------------

  private async handlePoll(url: URL): Promise<Response> {
    const cursor = Number.parseInt(url.searchParams.get('cursor') ?? '0', 10) || 0;
    const requestedTimeout = Number.parseInt(
      url.searchParams.get('timeoutMs') ?? String(DEFAULT_POLL_TIMEOUT_MS),
      10
    );
    const timeoutMs = Math.min(
      Math.max(100, Number.isFinite(requestedTimeout) ? requestedTimeout : DEFAULT_POLL_TIMEOUT_MS),
      MAX_POLL_TIMEOUT_MS
    );

    // Immediate return if new events already exist or stream is closed.
    const existing = this.bufferAfter(cursor);
    if (existing.length > 0 || this.closed) {
      return this.buildPollResponse(existing);
    }

    // Otherwise wait up to timeoutMs for an append() call or stream closure.
    await this.wait(timeoutMs);
    const late = this.bufferAfter(cursor);
    return this.buildPollResponse(late);
  }

  private bufferAfter(cursor: number): BufferedEvent[] {
    if (cursor <= 0) return this.buffer.slice();
    // linear scan is fine — buffer is bounded by MAX_BUFFERED_EVENTS.
    return this.buffer.filter((e) => e.cursor > cursor);
  }

  private buildPollResponse(events: BufferedEvent[]): Response {
    const lastCursor = events.length > 0
      ? events[events.length - 1]!.cursor
      : (this.buffer.length > 0 ? this.buffer[this.buffer.length - 1]!.cursor : 0);
    return Response.json({
      events: events.map((e) => ({ cursor: e.cursor, event: e.event })),
      cursor: lastCursor,
      closed: this.closed,
    });
  }

  // -------------------------------------------------------------------------
  // Close
  // -------------------------------------------------------------------------

  private async handleClose(): Promise<Response> {
    this.closed = true;
    this.wakeWaiters();
    return Response.json({ closed: true });
  }

  // -------------------------------------------------------------------------
  // Wait / wake
  // -------------------------------------------------------------------------

  private wait(timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.waiters.delete(waiter);
        resolve();
      }, timeoutMs);
      const waiter: Waiter = {
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        timer,
      };
      this.waiters.add(waiter);
    });
  }

  private wakeWaiters(): void {
    const all = Array.from(this.waiters);
    this.waiters.clear();
    for (const w of all) w.resolve();
  }
}
