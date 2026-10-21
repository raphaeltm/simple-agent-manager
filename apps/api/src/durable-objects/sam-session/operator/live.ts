import {
  type GroundingIndex,
  isGroundedText,
  PLATFORM_IDENTIFIER_PATTERN,
  PLATFORM_URL_PATTERN,
} from './grounding';

/** What the running turn is doing right now, for the status line. */
export type LivePhase = 'starting' | 'thinking' | 'working' | 'writing';
export type LiveToolState = 'running' | 'completed' | 'failed' | 'needs_approval' | 'uncertain';

export interface LiveActivity {
  id: string;
  operation: string;
  state: LiveToolState;
  /** Descriptive inputs only (which project/chat, a search query, filters), never briefs. */
  target?: Record<string, string | number | boolean>;
  /** Items returned by a list read, and whether more pages exist. */
  count?: number;
  more?: boolean;
}

export interface LiveSnapshot {
  turnId: string;
  phase: LivePhase;
  elapsedMs: number;
  /** Published answer text of the current model step. */
  text: string;
  /** Latest complete sentence or line of the model's reasoning, shown as a short preview. */
  thinking: string | null;
  activity: LiveActivity[];
}

export type LiveEvent =
  | ({ type: 'snapshot' } & LiveSnapshot)
  | { type: 'phase'; phase: LivePhase }
  | { type: 'text'; at: number; text: string }
  | { type: 'draft-reset' }
  | { type: 'thinking'; text: string | null }
  | { type: 'tool'; activity: LiveActivity }
  | { type: 'done'; state: string };

export interface LiveSettings {
  flushMs: number;
  heartbeatMs: number;
  maxSubscribers: number;
}

/** Minimal structural view of a Mastra stream chunk; unknown chunk types are ignored. */
export interface LiveChunk {
  type: string;
  payload?: unknown;
}

const TARGET_FIELDS = ['projectId', 'sessionId', 'taskId', 'ideaId', 'query', 'status', 'limit'];
const COUNTED_FIELDS = ['projects', 'tasks', 'chats', 'ideas', 'profiles', 'results', 'pending'];
/** Reasoning kept for the preview; older reasoning is never shown. */
const REASONING_TAIL_CHARS = 4_000;
const THINKING_PREVIEW_MAX_CHARS = 160;
/**
 * A reader this far behind is dropped instead of growing the queue without bound. A memory
 * safety valve, not a tunable: one turn emits a few hundred frames at most (answer deltas
 * per flush, two per tool step, heartbeats), so only a stalled reader reaches it.
 */
const MAX_QUEUED_EVENTS = 512;

interface Subscriber {
  controller: ReadableStreamDefaultController<Uint8Array>;
  heartbeat: ReturnType<typeof setInterval>;
}

interface LiveTurn {
  id: string;
  startedAt: number;
  phase: LivePhase;
  released: string;
  pending: string;
  /** A prefix failed the publication guard: publish nothing more for this step. */
  blocked: boolean;
  reasoning: string;
  thinking: string | null;
  activity: LiveActivity[];
  stepHadTools: boolean;
  grounding: GroundingIndex | null;
  flushTimer: ReturnType<typeof setTimeout> | null;
}

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const encoder = new TextEncoder();

/**
 * In-memory live view of the one running private turn (the store allows one active
 * turn). Nothing here is persisted: the canonical turn row, receipts and final answer
 * stay authoritative, and a reconnect receives a snapshot. Answer and reasoning text is
 * published only in whitespace-bounded prefixes that pass the receipt guard, so the
 * live view can never show what the final publication guard would reject.
 */
export class OperatorLive {
  private turn: LiveTurn | null = null;
  private readonly subscribers = new Set<Subscriber>();

  constructor(
    private readonly settings: () => LiveSettings,
    private readonly now: () => number = () => Date.now()
  ) {}

  begin(turnId: string, startedAt = this.now()): void {
    this.end(this.turn?.id ?? turnId, 'superseded');
    this.turn = {
      id: turnId,
      startedAt,
      phase: 'starting',
      released: '',
      pending: '',
      blocked: false,
      reasoning: '',
      thinking: null,
      activity: [],
      stepHadTools: false,
      grounding: null,
      flushTimer: null,
    };
  }

  /** Receipts changed: later text may cite them. Nothing is published before the first index. */
  setGrounding(index: GroundingIndex): void {
    if (!this.turn) return;
    this.turn.grounding = index;
    this.scheduleFlush();
  }

  chunk(chunk: LiveChunk): void {
    const turn = this.turn;
    if (!turn) return;
    const payload = record(chunk.payload);
    switch (chunk.type) {
      case 'reasoning-delta':
        if (typeof payload.text !== 'string') return;
        turn.reasoning = (turn.reasoning + payload.text).slice(-REASONING_TAIL_CHARS);
        if (!turn.released && !turn.pending) this.setPhase(turn, 'thinking');
        this.scheduleFlush();
        return;
      case 'text-delta':
        if (typeof payload.text !== 'string') return;
        turn.pending += payload.text;
        this.setPhase(turn, 'writing');
        this.scheduleFlush();
        return;
      case 'tool-call':
        turn.stepHadTools = true;
        this.updateTool(turn, payload, { state: 'running', target: targetOf(payload.args) });
        this.setPhase(turn, 'working');
        return;
      case 'tool-result':
        this.updateTool(turn, payload, resultOf(payload.result, payload.isError === true));
        if (!turn.activity.some((item) => item.state === 'running'))
          this.setPhase(turn, 'thinking');
        return;
      case 'tool-error':
        this.updateTool(turn, payload, { state: 'failed' });
        if (!turn.activity.some((item) => item.state === 'running'))
          this.setPhase(turn, 'thinking');
        return;
      default:
        return;
    }
  }

  /**
   * Step boundaries come from the agent's step hooks: Mastra's chunk callback carries
   * deltas, tool calls and tool results, but not step-start/step-finish chunks.
   */
  stepStarted(): void {
    if (!this.turn) return;
    this.clearStep(this.turn);
    this.setPhase(this.turn, 'thinking');
  }

  stepFinished(hadToolCalls: boolean): void {
    const turn = this.turn;
    if (!turn) return;
    // The run's text is the last step's text; pre-tool narration is not part of it.
    if (hadToolCalls || turn.stepHadTools) this.clearStep(turn);
    else this.flush(true);
  }

  /** The unpublished draft was rejected and is being regenerated. */
  resetDraft(): void {
    this.stepStarted();
  }

  /**
   * The final answer passed the publication guard: make the live draft exactly that
   * text before `done`, whatever deltas the stream did or did not deliver.
   */
  complete(text: string): void {
    const turn = this.turn;
    if (!turn) return;
    if (turn.flushTimer) clearTimeout(turn.flushTimer);
    turn.flushTimer = null;
    if (!text.startsWith(turn.released)) {
      turn.released = '';
      this.broadcast({ type: 'draft-reset' });
    }
    if (text.length > turn.released.length)
      this.broadcast({
        type: 'text',
        at: turn.released.length,
        text: text.slice(turn.released.length),
      });
    turn.released = text;
    turn.pending = '';
  }

  /** Called after the turn's terminal state is stored, so a refetch shows the outcome. */
  end(turnId: string, state: string): void {
    const turn = this.turn;
    if (turn?.id !== turnId) return;
    if (turn.flushTimer) clearTimeout(turn.flushTimer);
    this.turn = null;
    this.broadcast({ type: 'done', state });
    for (const subscriber of [...this.subscribers]) this.drop(subscriber, true);
  }

  snapshot(turnId: string): LiveSnapshot | null {
    const turn = this.turn;
    if (turn?.id !== turnId) return null;
    return {
      turnId,
      phase: turn.phase,
      elapsedMs: Math.max(0, this.now() - turn.startedAt),
      text: turn.released,
      thinking: turn.thinking,
      activity: turn.activity.map((item) => ({ ...item })),
    };
  }

  /** Server-sent events for the running turn; 204 when it is not running here. */
  subscribe(turnId: string): Response {
    const snapshot = this.snapshot(turnId);
    if (!snapshot) return new Response(null, { status: 204 });
    const { heartbeatMs, maxSubscribers } = this.settings();
    if (this.subscribers.size >= maxSubscribers)
      return Response.json(
        { error: 'too_many_streams', message: 'Close another SAM tab to follow this turn live.' },
        { status: 429 }
      );
    let subscriber: Subscriber | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        const current: Subscriber = {
          controller,
          heartbeat: setInterval(() => this.write(current, ': ping\n\n'), heartbeatMs),
        };
        subscriber = current;
        this.subscribers.add(current);
        this.send(current, { type: 'snapshot', ...snapshot });
      },
      cancel: () => {
        if (subscriber) this.drop(subscriber, false);
      },
    });
    return new Response(stream, {
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        'x-accel-buffering': 'no',
      },
    });
  }

  private clearStep(turn: LiveTurn): void {
    const hadDraft = turn.released.length > 0;
    turn.released = '';
    turn.pending = '';
    turn.blocked = false;
    turn.reasoning = '';
    turn.stepHadTools = false;
    if (turn.thinking !== null) {
      turn.thinking = null;
      this.broadcast({ type: 'thinking', text: null });
    }
    if (hadDraft) this.broadcast({ type: 'draft-reset' });
  }

  private setPhase(turn: LiveTurn, phase: LivePhase): void {
    if (turn.phase === phase) return;
    turn.phase = phase;
    this.broadcast({ type: 'phase', phase });
  }

  private updateTool(
    turn: LiveTurn,
    payload: Record<string, unknown>,
    update: Partial<LiveActivity>
  ) {
    const id = typeof payload.toolCallId === 'string' ? payload.toolCallId : null;
    const operation = typeof payload.toolName === 'string' ? payload.toolName : null;
    if (!id || !operation) return;
    let item = turn.activity.find((entry) => entry.id === id);
    if (!item) {
      item = { id, operation, state: 'running' };
      turn.activity.push(item);
    }
    Object.assign(
      item,
      Object.fromEntries(Object.entries(update).filter(([, v]) => v !== undefined))
    );
    this.broadcast({ type: 'tool', activity: { ...item } });
  }

  private scheduleFlush(): void {
    const turn = this.turn;
    if (!turn || turn.flushTimer) return;
    turn.flushTimer = setTimeout(() => {
      turn.flushTimer = null;
      if (this.turn === turn) this.flush(false);
    }, this.settings().flushMs);
  }

  /**
   * Re-checks the whole published prefix each time, which keeps the guard argument simple.
   * Measured 2026-10-21: 0.22 ms per check at the 16 KB answer ceiling, about 60 ms of CPU
   * across a maximal turn at the default cadence, so a windowed check is not worth its risk.
   */
  private flush(stepComplete: boolean): void {
    const turn = this.turn;
    if (!turn?.grounding) return;
    if (!turn.blocked && turn.pending) {
      const candidate = turn.released + turn.pending;
      const cut = stepComplete ? candidate.length : afterLastWhitespace(candidate);
      if (cut > turn.released.length) {
        const prefix = candidate.slice(0, cut);
        if (isGroundedText(prefix, turn.grounding)) {
          this.broadcast({
            type: 'text',
            at: turn.released.length,
            text: prefix.slice(turn.released.length),
          });
          turn.released = prefix;
          turn.pending = candidate.slice(cut);
        } else {
          turn.blocked = true;
        }
      }
    }
    const preview = thinkingPreview(turn.reasoning);
    if (preview && preview !== turn.thinking && isGroundedText(preview, turn.grounding)) {
      turn.thinking = preview;
      this.broadcast({ type: 'thinking', text: preview });
    }
  }

  private broadcast(event: LiveEvent): void {
    for (const subscriber of [...this.subscribers]) this.send(subscriber, event);
  }

  private send(subscriber: Subscriber, event: LiveEvent): void {
    this.write(subscriber, `data: ${JSON.stringify(event)}\n\n`);
  }

  private write(subscriber: Subscriber, frame: string): void {
    try {
      if ((subscriber.controller.desiredSize ?? 0) < -MAX_QUEUED_EVENTS) {
        this.drop(subscriber, true);
        return;
      }
      subscriber.controller.enqueue(encoder.encode(frame));
    } catch {
      // The reader went away between frames.
      this.drop(subscriber, false);
    }
  }

  private drop(subscriber: Subscriber, close: boolean): void {
    if (!this.subscribers.delete(subscriber)) return;
    clearInterval(subscriber.heartbeat);
    if (!close) return;
    try {
      subscriber.controller.close();
    } catch {
      /* Already closed or errored by the reader. */
    }
  }
}

function afterLastWhitespace(text: string): number {
  for (let index = text.length - 1; index >= 0; index--)
    if (/\s/.test(text.charAt(index))) return index + 1;
  return 0;
}

function targetOf(args: unknown): LiveActivity['target'] {
  const input = record(args);
  const target: Record<string, string | number | boolean> = {};
  for (const field of TARGET_FIELDS) {
    const value = input[field];
    if (typeof value === 'string' && value.length > 0) target[field] = value.slice(0, 200);
    else if (typeof value === 'number' || typeof value === 'boolean') target[field] = value;
  }
  return Object.keys(target).length ? target : undefined;
}

function resultOf(result: unknown, isError: boolean): Partial<LiveActivity> {
  if (isError) return { state: 'failed' };
  const value = record(result);
  if (value.status === 'approval_required') return { state: 'needs_approval' };
  if (value.status === 'uncertain' || value.dispatchState === 'uncertain')
    return { state: 'uncertain' };
  const field = COUNTED_FIELDS.find((name) => Array.isArray(value[name]));
  return {
    state: 'completed',
    ...(field ? { count: (value[field] as unknown[]).length } : {}),
    ...(field ? { more: typeof value.nextCursor === 'string' && value.nextCursor.length > 0 } : {}),
  };
}

/**
 * The latest complete sentence or line of reasoning, plain text, bounded. Low-effort
 * reasoning is often one paragraph, so waiting for a newline would show nothing.
 * Reasoning is under no instruction to label or link what it mentions, and the receipt
 * guard checks only labelled identifiers, so raw identifiers and links are removed here
 * rather than shown unchecked; the preview is a hint of what SAM is doing, not a source.
 */
function thinkingPreview(reasoning: string): string | null {
  const lines = reasoning.split(/\n|(?<=[.!?])\s+/);
  lines.pop(); // The last segment has no end yet: still being written.
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = (lines[index] ?? '')
      .replace(PLATFORM_URL_PATTERN, '…')
      .replace(PLATFORM_IDENTIFIER_PATTERN, '…')
      .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '')
      // Emphasis markers go; an underscore inside a word (a tool name) stays.
      .replace(/[*`#]+|(?<!\w)_+|_+(?!\w)/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    // A bare list number ("1.") is left over from the sentence split, not a thought.
    if (!/\p{L}{2}/u.test(line)) continue;
    if (line.length <= THINKING_PREVIEW_MAX_CHARS) return line;
    const clipped = line.slice(0, THINKING_PREVIEW_MAX_CHARS);
    return `${clipped.slice(0, Math.max(clipped.lastIndexOf(' '), 1))}…`;
  }
  return null;
}
