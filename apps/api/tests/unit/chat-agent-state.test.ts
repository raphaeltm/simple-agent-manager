/**
 * Behavioral tests for `resolveChatAgentState`.
 *
 * Two things are asserted:
 *
 *  1. **DO roundtrip budget** — the resolver must cost two sequential Durable
 *     Object hops, not four. The mocks record which "hop" each call landed in by
 *     tracking how many calls were in flight concurrently. Discriminating: the
 *     hop assertions fail against the pre-fix sequential implementation.
 *
 *  2. **Response equivalence** — every branch of the original sequential
 *     implementation returns the same value, including the optional
 *     `activitySource` / `activityReason` snapshot members that the plan merge
 *     drops, and the four independent failure paths.
 *
 * Mocks are argument-keyed (not `mockResolvedValueOnce` order-keyed) so they stay
 * valid regardless of call ordering — see .claude/rules/35.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listAcpSessions: vi.fn(),
  getSessionState: vi.fn(),
  getLatestPersistedPlan: vi.fn(),
}));

vi.mock('../../src/services/project-data', () => mocks);

import { resolveChatAgentState } from '../../src/routes/chat-agent-state';

const PROJECT_ID = 'proj-1';
const CHAT_SESSION_ID = 'chat-1';
const ACP_SESSION_ID = 'acp-1';

interface HopTracker {
  /** Number of distinct sequential waves of DO calls. */
  hops: number;
  /** Total DO calls issued. */
  calls: number;
  callNames: string[];
  /**
   * Highest number of calls simultaneously in flight. `hops` alone cannot see a
   * *partial* re-serialization inside a wave (a call chained off another's
   * result still reads as the same hop while a third call keeps the wave open),
   * so tests assert peak concurrency too.
   */
  peakConcurrency: number;
}

function makeHopTracker(): HopTracker {
  return { hops: 0, calls: 0, callNames: [], peakConcurrency: 0 };
}

let tracker: HopTracker;
let inFlight = 0;

function tracked<T>(name: string, produce: () => T | Promise<T>): Promise<T> {
  tracker.calls += 1;
  tracker.callNames.push(name);
  if (inFlight === 0) tracker.hops += 1;
  inFlight += 1;
  if (inFlight > tracker.peakConcurrency) tracker.peakConcurrency = inFlight;
  // Resolve on a macrotask so concurrent calls genuinely overlap.
  return new Promise<T>((resolve, reject) => {
    setTimeout(() => {
      inFlight -= 1;
      try {
        resolve(produce() as T);
      } catch (err) {
        reject(err as Error);
      }
    }, 0);
  });
}

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    activity: 'prompting',
    activityAt: 100,
    statusError: null,
    currentPlan: null,
    planUpdatedAt: null,
    promptStartedAt: 90,
    agentType: 'openai-codex',
    lastStopReason: null,
    runtimeWorkState: null,
    runtimeWorkCount: null,
    runtimeWorkSource: null,
    runtimeWorkUpdatedAt: null,
    runtimeWorkProgressAt: null,
    ...overrides,
  };
}

/**
 * Wire realistic DO state: an ACP session row, a per-session state row keyed by
 * session id, and a durable plan row.
 */
function setupDo(options: {
  acpSessions?: Array<{ id: string; agentType: string }>;
  states?: Record<string, unknown>;
  plan?: unknown;
  failures?: Partial<Record<'listAcpSessions' | 'getLatestPersistedPlan', Error>>;
  stateFailures?: Record<string, Error>;
}) {
  const {
    acpSessions = [{ id: ACP_SESSION_ID, agentType: 'openai-codex' }],
    states = {},
    plan = null,
    failures = {},
    stateFailures = {},
  } = options;

  mocks.listAcpSessions.mockImplementation(() =>
    tracked('listAcpSessions', () => {
      if (failures.listAcpSessions) throw failures.listAcpSessions;
      return { sessions: acpSessions };
    })
  );

  mocks.getSessionState.mockImplementation((_env: unknown, _projectId: string, sessionId: string) =>
    tracked(`getSessionState:${sessionId}`, () => {
      const failure = stateFailures[sessionId];
      if (failure) throw failure;
      return states[sessionId] ?? null;
    })
  );

  mocks.getLatestPersistedPlan.mockImplementation(() =>
    tracked('getLatestPersistedPlan', () => {
      if (failures.getLatestPersistedPlan) throw failures.getLatestPersistedPlan;
      return plan;
    })
  );
}

function resolve(overrides: Partial<Parameters<typeof resolveChatAgentState>[1]> = {}) {
  return resolveChatAgentState({} as never, {
    projectId: PROJECT_ID,
    sessionId: CHAT_SESSION_ID,
    lookupFailureEvent: 'lookup.failed',
    stateFailureEvent: 'state.failed',
    ...overrides,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  tracker = makeHopTracker();
  inFlight = 0;
});

describe('resolveChatAgentState — DO roundtrip budget', () => {
  it('costs two sequential DO hops in the common case', async () => {
    setupDo({ states: { [ACP_SESSION_ID]: snapshot() }, plan: null });

    await resolve();

    // Same four DO calls as before, but issued in two waves instead of four.
    // Pre-fix `hops` was 4 (fully sequential) — the discriminating assertion.
    expect(tracker.hops).toBe(2);
    expect(tracker.calls).toBe(4);
    // All three hop-2 reads must be in flight together. This is what catches a
    // partial re-serialization inside hop 2, which `hops` alone cannot see.
    expect(tracker.peakConcurrency).toBe(3);
  });

  it('issues the ACP-session lookup alone in hop 1', async () => {
    setupDo({ states: { [ACP_SESSION_ID]: snapshot() } });

    await resolve();

    expect(tracker.callNames[0]).toBe('listAcpSessions');
    expect(tracker.callNames.slice(1).sort()).toEqual(
      [
        `getSessionState:${ACP_SESSION_ID}`,
        `getSessionState:${CHAT_SESSION_ID}`,
        'getLatestPersistedPlan',
      ].sort()
    );
  });

  it('skips the ACP state read when there is no ACP session', async () => {
    const chatState = snapshot({ activity: 'idle', activityAt: 7 });
    setupDo({ acpSessions: [], states: { [CHAT_SESSION_ID]: chatState } });

    const result = await resolve();

    expect(tracker.hops).toBe(2);
    expect(tracker.callNames).not.toContain(`getSessionState:${ACP_SESSION_ID}`);
    expect(tracker.callNames).toContain(`getSessionState:${CHAT_SESSION_ID}`);
    // The returned value for this branch must match the sequential version too,
    // not just the call pattern.
    expect(result.agentSessionId).toBeNull();
    expect(result.agentType).toBeNull();
    expect(result.state).toEqual(chatState);
  });

  it('does not read the same session state twice when the ids coincide', async () => {
    setupDo({
      acpSessions: [{ id: CHAT_SESSION_ID, agentType: 'claude-code' }],
      states: { [CHAT_SESSION_ID]: snapshot() },
    });

    await resolve();

    const stateReads = tracker.callNames.filter((n) => n.startsWith('getSessionState:'));
    expect(stateReads).toEqual([`getSessionState:${CHAT_SESSION_ID}`]);
  });
});

describe('resolveChatAgentState — response equivalence', () => {
  it('returns the ACP session identity and its state', async () => {
    const state = snapshot();
    setupDo({ states: { [ACP_SESSION_ID]: state } });

    const result = await resolve();

    expect(result.agentSessionId).toBe(ACP_SESSION_ID);
    expect(result.agentType).toBe('openai-codex');
    expect(result.state).toEqual(state);
  });

  it('falls back to the chat-session state when the ACP session has none', async () => {
    const chatState = snapshot({ activity: 'idle', activityAt: 42 });
    setupDo({ states: { [CHAT_SESSION_ID]: chatState } });

    const result = await resolve();

    expect(result.agentSessionId).toBe(ACP_SESSION_ID);
    expect(result.state).toEqual(chatState);
  });

  it('returns null state and identity when nothing exists', async () => {
    setupDo({ acpSessions: [] });

    const result = await resolve();

    expect(result).toEqual({ agentSessionId: null, agentType: null, state: null });
  });

  it('hydrates the plan from durable chat messages when the ACP mirror has none', async () => {
    const currentPlan = [{ content: 'Restore from durable plan row', status: 'in_progress' }];
    setupDo({
      states: { [ACP_SESSION_ID]: snapshot() },
      plan: { currentPlan, planUpdatedAt: 1234 },
    });

    const result = await resolve();

    expect(result.state?.activity).toBe('prompting');
    expect(result.state?.currentPlan).toEqual(currentPlan);
    expect(result.state?.planUpdatedAt).toBe(1234);
    expect(mocks.getLatestPersistedPlan).toHaveBeenCalledWith({}, PROJECT_ID, CHAT_SESSION_ID);
  });

  it('prefers the persisted plan over the chat-session-state plan', async () => {
    const persisted = [{ content: 'durable', status: 'pending' }];
    const mirrored = [{ content: 'mirror', status: 'pending' }];
    setupDo({
      states: {
        [ACP_SESSION_ID]: snapshot(),
        [CHAT_SESSION_ID]: snapshot({ currentPlan: mirrored, planUpdatedAt: 1 }),
      },
      plan: { currentPlan: persisted, planUpdatedAt: 2 },
    });

    const result = await resolve();

    expect(result.state?.currentPlan).toEqual(persisted);
    expect(result.state?.planUpdatedAt).toBe(2);
  });

  it('falls back to the chat-session-state plan when no plan is persisted', async () => {
    const mirrored = [{ content: 'mirror', status: 'completed' }];
    setupDo({
      states: {
        [ACP_SESSION_ID]: snapshot(),
        [CHAT_SESSION_ID]: snapshot({ currentPlan: mirrored, planUpdatedAt: 7 }),
      },
      plan: null,
    });

    const result = await resolve();

    expect(result.state?.currentPlan).toEqual(mirrored);
    expect(result.state?.planUpdatedAt).toBe(7);
    // Non-plan fields still come from the ACP session state.
    expect(result.state?.activity).toBe('prompting');
  });

  it('preserves optional snapshot members when no plan merge happens', async () => {
    const state = snapshot({ activitySource: 'agent', activityReason: 'end_turn' });
    setupDo({ states: { [ACP_SESSION_ID]: state } });

    const result = await resolve();

    // No planSource → the snapshot is returned untouched, keeping the optional
    // members the plan-merge rebuild would drop.
    expect(result.state).toEqual(state);
    expect(result.state).toHaveProperty('activitySource', 'agent');
    expect(result.state).toHaveProperty('activityReason', 'end_turn');
  });

  it('returns null state when the ids coincide and the single state read fails', async () => {
    // The documented deviation: the sequential version would have re-issued the
    // identical read here (a retry-of-last-resort). The new version does not.
    // Pin the resulting value so the choice is asserted, not just described.
    setupDo({
      acpSessions: [{ id: CHAT_SESSION_ID, agentType: 'claude-code' }],
      stateFailures: { [CHAT_SESSION_ID]: new Error('state boom') },
      plan: null,
    });

    const result = await resolve();

    expect(result.agentSessionId).toBe(CHAT_SESSION_ID);
    expect(result.agentType).toBe('claude-code');
    expect(result.state).toBeNull();
    const stateReads = tracker.callNames.filter((n) => n.startsWith('getSessionState:'));
    expect(stateReads).toHaveLength(1);
  });

  it('does not populate the chat-session plan fallback when the ids coincide', async () => {
    // Matches the pre-fix behaviour: with agentSessionId === sessionId the
    // sequential implementation left chatSessionState null, so a mirrored plan
    // must NOT trigger the merge (which would drop the optional members).
    const state = snapshot({
      currentPlan: [{ content: 'mirror', status: 'pending' }],
      planUpdatedAt: 5,
      activitySource: 'agent',
      activityReason: 'end_turn',
    });
    setupDo({
      acpSessions: [{ id: CHAT_SESSION_ID, agentType: 'claude-code' }],
      states: { [CHAT_SESSION_ID]: state },
      plan: null,
    });

    const result = await resolve();

    expect(result.state).toEqual(state);
    expect(result.state).toHaveProperty('activitySource', 'agent');
  });
});

describe('resolveChatAgentState — independent failure handling', () => {
  it('still resolves state and plan when the ACP session lookup fails', async () => {
    const chatState = snapshot({ activity: 'idle' });
    setupDo({
      states: { [CHAT_SESSION_ID]: chatState },
      failures: { listAcpSessions: new Error('acp boom') },
    });

    const result = await resolve();

    expect(result.agentSessionId).toBeNull();
    expect(result.agentType).toBeNull();
    expect(result.state).toEqual(chatState);
  });

  it('falls back to the chat-session state when the ACP state read fails', async () => {
    const chatState = snapshot({ activity: 'idle' });
    setupDo({
      states: { [CHAT_SESSION_ID]: chatState },
      stateFailures: { [ACP_SESSION_ID]: new Error('state boom') },
    });

    const result = await resolve();

    expect(result.agentSessionId).toBe(ACP_SESSION_ID);
    expect(result.state).toEqual(chatState);
  });

  it('keeps the ACP state when the chat-session state read fails', async () => {
    const acpState = snapshot();
    setupDo({
      states: { [ACP_SESSION_ID]: acpState },
      stateFailures: { [CHAT_SESSION_ID]: new Error('chat state boom') },
    });

    const result = await resolve();

    expect(result.state).toEqual(acpState);
  });

  it('skips the whole plan merge when the plan lookup fails', async () => {
    // The sequential implementation wrapped the plan lookup, the chat-state
    // fallback and the rebuild in one try block, so a plan failure suppressed the
    // fallback too.
    const acpState = snapshot({ activitySource: 'agent' });
    setupDo({
      states: {
        [ACP_SESSION_ID]: acpState,
        [CHAT_SESSION_ID]: snapshot({ currentPlan: [{ content: 'x', status: 'pending' }] }),
      },
      failures: { getLatestPersistedPlan: new Error('plan boom') },
    });

    const result = await resolve();

    expect(result.state).toEqual(acpState);
    expect(result.state?.currentPlan).toBeNull();
    expect(result.state).toHaveProperty('activitySource', 'agent');
  });

  it('tolerates every DO call failing', async () => {
    setupDo({
      failures: {
        listAcpSessions: new Error('a'),
        getLatestPersistedPlan: new Error('c'),
      },
      stateFailures: { [CHAT_SESSION_ID]: new Error('b') },
    });

    const result = await resolve();

    expect(result).toEqual({ agentSessionId: null, agentType: null, state: null });
  });

  it('degrades when a service function throws synchronously, not just rejects', async () => {
    // The sequential implementation wrapped the *call* in try/catch, so a
    // service function that throws before returning a promise degraded rather
    // than failing the request. `safeRead` preserves that; a bare `.catch()`
    // would not. Regression for commit 881091eec.
    mocks.listAcpSessions.mockImplementation(() =>
      tracked('listAcpSessions', () => ({ sessions: [] }))
    );
    mocks.getSessionState.mockImplementation(() => {
      throw new Error('sync boom');
    });
    mocks.getLatestPersistedPlan.mockImplementation(() => {
      throw new Error('sync plan boom');
    });

    const result = await resolve();

    expect(result).toEqual({ agentSessionId: null, agentType: null, state: null });
  });

  it('does not throw when stateFailureEvent is omitted', async () => {
    setupDo({
      states: {},
      stateFailures: { [ACP_SESSION_ID]: new Error('boom') },
    });

    await expect(resolve({ stateFailureEvent: undefined })).resolves.toBeDefined();
  });
});
