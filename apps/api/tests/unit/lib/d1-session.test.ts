/**
 * Request-scoped D1 session facade.
 *
 * These cover the facade's delegation contract. They deliberately do NOT claim anything
 * about replica routing or bookmark propagation: a node-environment harness has one engine
 * and no replicas, so it cannot observe either. The real-runtime proof lives in
 * `tests/workers/d1-request-session.test.ts` (`.claude/rules/69`).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createRequestScopedD1,
  D1_SESSION_MODES,
  DEFAULT_D1_SESSION_MODE,
  resolveD1BindingIdentity,
  resolveD1SessionMode,
  withRequestScopedD1Bindings,
} from '../../../src/lib/d1-session';

interface FakeSession {
  prepare: ReturnType<typeof vi.fn>;
  batch: ReturnType<typeof vi.fn>;
  getBookmark: ReturnType<typeof vi.fn>;
}

interface FakeBinding {
  withSession: ReturnType<typeof vi.fn>;
  prepare: ReturnType<typeof vi.fn>;
  batch: ReturnType<typeof vi.fn>;
  exec: ReturnType<typeof vi.fn>;
  dump: ReturnType<typeof vi.fn>;
  sessions: FakeSession[];
}

function makeBinding(): FakeBinding {
  const sessions: FakeSession[] = [];
  const binding: Partial<FakeBinding> = {
    prepare: vi.fn((query: string) => ({ source: 'binding', query })),
    batch: vi.fn(async () => [{ source: 'binding-batch' }]),
    exec: vi.fn(async () => ({ count: 1, duration: 0 })),
    dump: vi.fn(async () => new ArrayBuffer(8)),
    sessions,
  };
  binding.withSession = vi.fn((anchor?: string) => {
    const session: FakeSession = {
      prepare: vi.fn((query: string) => ({ source: 'session', anchor, query })),
      batch: vi.fn(async () => [{ source: 'session-batch', anchor }]),
      getBookmark: vi.fn(() => 'bookmark-1'),
    };
    sessions.push(session);
    return session;
  });
  return binding as FakeBinding;
}

function asD1(binding: unknown): D1Database {
  return binding as D1Database;
}

describe('resolveD1SessionMode', () => {
  it('defaults to first-primary', () => {
    expect(DEFAULT_D1_SESSION_MODE).toBe('first-primary');
    expect(resolveD1SessionMode(undefined)).toBe('first-primary');
    expect(resolveD1SessionMode({})).toBe('first-primary');
  });

  it('accepts every declared mode and rejects anything else', () => {
    for (const mode of D1_SESSION_MODES) {
      expect(resolveD1SessionMode({ D1_SESSION_MODE: mode })).toBe(mode);
      expect(resolveD1SessionMode({ D1_SESSION_MODE: ` ${mode} ` })).toBe(mode);
    }
    // An unconstrained anchor is NOT an operator knob: it would introduce a user-visible
    // cross-actor staleness window. Anything unrecognised falls back to the safe default.
    expect(resolveD1SessionMode({ D1_SESSION_MODE: 'first-unconstrained' })).toBe('first-primary');
    expect(resolveD1SessionMode({ D1_SESSION_MODE: '' })).toBe('first-primary');
  });
});

describe('createRequestScopedD1', () => {
  let binding: FakeBinding;

  beforeEach(() => {
    binding = makeBinding();
  });

  it('routes prepare and batch through ONE session anchored first-primary', async () => {
    const scoped = createRequestScopedD1(asD1(binding));

    expect(binding.withSession).not.toHaveBeenCalled(); // lazy: no D1 touch, no session

    const first = scoped.prepare('SELECT 1');
    const second = scoped.prepare('SELECT 2');
    await scoped.batch([]);

    expect(binding.withSession).toHaveBeenCalledTimes(1);
    expect(binding.withSession).toHaveBeenCalledWith('first-primary');
    expect(binding.sessions).toHaveLength(1);
    expect(first).toMatchObject({ source: 'session', anchor: 'first-primary' });
    expect(second).toMatchObject({ source: 'session' });
    expect(binding.prepare).not.toHaveBeenCalled();
  });

  it('delegates exec and dump to the raw binding (a session has neither)', async () => {
    const scoped = createRequestScopedD1(asD1(binding));

    await scoped.exec('PRAGMA foreign_keys = ON');
    await scoped.dump();

    expect(binding.exec).toHaveBeenCalledWith('PRAGMA foreign_keys = ON');
    expect(binding.dump).toHaveBeenCalledTimes(1);
    expect(binding.withSession).not.toHaveBeenCalled();
  });

  it('lets a caller open its own explicitly anchored session', () => {
    const scoped = createRequestScopedD1(asD1(binding));

    scoped.withSession('first-unconstrained');

    expect(binding.withSession).toHaveBeenCalledWith('first-unconstrained');
  });

  it('returns the raw binding when sessions are disabled', () => {
    const scoped = createRequestScopedD1(asD1(binding), 'disabled');

    expect(scoped).toBe(asD1(binding));
    scoped.prepare('SELECT 1');
    expect(binding.prepare).toHaveBeenCalledTimes(1);
    expect(binding.withSession).not.toHaveBeenCalled();
  });

  it('degrades to the raw binding on a runtime without withSession', () => {
    const legacy = { prepare: vi.fn(), batch: vi.fn(), exec: vi.fn(), dump: vi.fn() };

    const scoped = createRequestScopedD1(asD1(legacy));

    expect(scoped).toBe(asD1(legacy));
  });

  it('gives each request its own session', () => {
    createRequestScopedD1(asD1(binding)).prepare('SELECT 1');
    createRequestScopedD1(asD1(binding)).prepare('SELECT 1');

    expect(binding.withSession).toHaveBeenCalledTimes(2);
    expect(binding.sessions).toHaveLength(2);
  });
});

describe('resolveD1BindingIdentity', () => {
  it('unwraps a facade to the stable per-isolate binding', () => {
    const binding = makeBinding();
    const a = createRequestScopedD1(asD1(binding));
    const b = createRequestScopedD1(asD1(binding));

    expect(a).not.toBe(b);
    expect(resolveD1BindingIdentity(a)).toBe(asD1(binding));
    expect(resolveD1BindingIdentity(b)).toBe(asD1(binding));
    // Two facades over one binding must agree — this is what keeps identity-keyed
    // per-isolate caches (resolvePlatformConfig) hitting across requests.
    expect(resolveD1BindingIdentity(a)).toBe(resolveD1BindingIdentity(b));
  });

  it('returns a raw binding unchanged, and passes undefined through', () => {
    const binding = asD1(makeBinding());

    expect(resolveD1BindingIdentity(binding)).toBe(binding);
    expect(resolveD1BindingIdentity(undefined)).toBeUndefined();
  });

  it('does not treat an arbitrary object as a facade', () => {
    const impostor = asD1({ prepare: vi.fn() });

    expect(resolveD1BindingIdentity(impostor)).toBe(impostor);
  });
});

describe('withRequestScopedD1Bindings', () => {
  it('scopes both databases and leaves every other binding untouched', () => {
    const database = makeBinding();
    const observability = makeBinding();
    const kv = { get: vi.fn() };
    const env = {
      DATABASE: asD1(database),
      OBSERVABILITY_DATABASE: asD1(observability),
      KV: kv,
      BASE_DOMAIN: 'example.test',
    };

    const scoped = withRequestScopedD1Bindings(env);

    expect(scoped).not.toBe(env);
    expect(Object.keys(scoped).sort()).toEqual(Object.keys(env).sort());
    expect(scoped.KV).toBe(kv);
    expect(scoped.BASE_DOMAIN).toBe('example.test');
    expect(resolveD1BindingIdentity(scoped.DATABASE)).toBe(asD1(database));
    expect(resolveD1BindingIdentity(scoped.OBSERVABILITY_DATABASE)).toBe(asD1(observability));
    // The original env is never mutated — `scheduled()` and Durable Objects keep the raw
    // bindings because they receive the runtime's env, not this clone.
    expect(env.DATABASE).toBe(asD1(database));
  });

  it('returns the original env when sessions are disabled', () => {
    const env = {
      DATABASE: asD1(makeBinding()),
      OBSERVABILITY_DATABASE: asD1(makeBinding()),
      D1_SESSION_MODE: 'disabled',
    };

    expect(withRequestScopedD1Bindings(env)).toBe(env);
  });

  it('returns the original env when no binding supports sessions', () => {
    const env = {
      DATABASE: asD1({ prepare: vi.fn(), batch: vi.fn() }),
      OBSERVABILITY_DATABASE: undefined,
    };

    expect(withRequestScopedD1Bindings(env)).toBe(env);
  });

  it('scopes DATABASE even when OBSERVABILITY_DATABASE is absent', () => {
    const database = makeBinding();
    const env = { DATABASE: asD1(database), OBSERVABILITY_DATABASE: undefined };

    const scoped = withRequestScopedD1Bindings(env);

    expect(resolveD1BindingIdentity(scoped.DATABASE)).toBe(asD1(database));
    expect(scoped.OBSERVABILITY_DATABASE).toBeUndefined();
  });
});
