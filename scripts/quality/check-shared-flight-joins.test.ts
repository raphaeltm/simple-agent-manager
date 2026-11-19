import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { Project } from 'ts-morph';
import { describe, expect, it } from 'vitest';

import {
  ALLOW_DIRECTIVE,
  findSharedFlightJoins,
  listModulePromiseHolders,
} from './check-shared-flight-joins';

function scan(code: string) {
  const project = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: { target: 99, lib: ['lib.es2022.d.ts'], strict: true },
  });
  const file = project.createSourceFile('/src/flight.ts', code);
  return {
    findings: findSharedFlightJoins([file], '/'),
    holders: listModulePromiseHolders([file], '/'),
  };
}

const HELPER = `
declare function settleSharedFlight<T>(p: Promise<T>, deadlineAt: number): Promise<{ abandoned: true } | { abandoned: false; value: T }>;
declare function read(): Promise<string>;
`;

describe('shared-flight join guard', () => {
  it('flags the platform-config shape: an entry object in a module-scope `let`', () => {
    const { findings, holders } = scan(`${HELPER}
      let inFlight: { deadlineAt: number; promise: Promise<string> } | null = null;
      export async function resolve(): Promise<string> {
        const joinable = inFlight;
        if (joinable) return await joinable.promise;
        const promise = read();
        inFlight = { deadlineAt: Date.now() + 5000, promise };
        return await promise;
      }`);
    expect(findings).toEqual([
      expect.objectContaining({
        file: 'src/flight.ts',
        root: 'inFlight',
        code: 'joinable.promise',
      }),
    ]);
    expect(holders.map((h) => h.name)).toEqual(['inFlight']);
  });

  it('flags a Map of promises joined through .get(), with and without await', () => {
    const { findings } = scan(`${HELPER}
      const pending = new Map<string, Promise<string>>();
      export async function viaAwait(key: string) {
        const hit = pending.get(key);
        if (hit) await hit;
      }
      export function viaReturn(key: string): Promise<string> | undefined {
        return pending.get(key);
      }
      export async function viaRace(key: string) {
        await Promise.race([pending.get(key)!, read()]);
      }
      export const viaArrow = async (key: string) => pending.get(key);`);
    expect(findings.map((f) => f.code).sort()).toEqual([
      'hit',
      'pending.get(key)',
      'pending.get(key)',
      'pending.get(key)!',
    ]);
    expect(findings.every((f) => f.root === 'pending')).toBe(true);
  });

  it('flags a destructured alias and a nested entry map', () => {
    const { findings } = scan(`${HELPER}
      const cache = new WeakMap<object, Map<string, { promise: Promise<string> }>>();
      export async function nested(db: object, key: string) {
        const entry = cache.get(db)?.get(key);
        if (!entry) return;
        const { promise } = entry;
        await promise;
      }`);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.root).toBe('cache');
  });

  it('passes the sanctioned helper, a starter awaiting its own read, and non-promise state', () => {
    const { findings } = scan(`${HELPER}
      let inFlight: { deadlineAt: number; promise: Promise<string> } | null = null;
      let cached: { value: string } | null = null;
      export async function resolve(): Promise<string> {
        if (cached) return cached.value;
        const joinable = inFlight;
        if (joinable) {
          const joined = await settleSharedFlight(joinable.promise, joinable.deadlineAt);
          if (!joined.abandoned) return joined.value;
        }
        const promise = read();
        const entry = { deadlineAt: Date.now() + 5000, promise };
        inFlight = entry;
        const value = await entry.promise;
        cached = { value };
        return value;
      }`);
    expect(findings).toEqual([]);
  });

  it('flags a module-held class instance joining its own flight field (the R6 shape)', () => {
    // One instance in module scope serves every request in the isolate, so its fields are
    // request-shared state: the admin-settings cache, where task R6's hangs were.
    const { findings } = scan(`${HELPER}
      class Cache { private flight?: Promise<string>; async read() { return (this.flight ??= read()); } }
      export const cache = new Cache();
      export async function use() { return await cache.read(); }`);
    expect(findings).toEqual([expect.objectContaining({ root: 'this.flight', kind: 'awaits' })]);
  });

  it('does not treat fields of a class instantiated per call as shared', () => {
    // Control for the case above: the same class, with no module-scope instance.
    const { findings } = scan(`${HELPER}
      class Cache { private flight?: Promise<string>; async read() { return (this.flight ??= read()); } }
      export async function use() { return await new Cache().read(); }`);
    expect(findings).toEqual([]);
  });

  it('flags a continuation attached to a shared flight, awaited or not', () => {
    // On celld the continuation runs as part of the request that settles the flight (task R6).
    const { findings } = scan(`${HELPER}
      const pending = new Map<string, Promise<string>>();
      export function onSettle(key: string, record: (value: string) => void) {
        pending.get(key)?.then(record);
      }
      export function onFailure(key: string) {
        void pending.get(key)?.catch(() => undefined);
      }`);
    expect(findings.map((f) => f.kind)).toEqual(['continues', 'continues']);
    expect(findings.every((f) => f.root === 'pending')).toBe(true);
  });

  it('flags a shared flight handed to a helper other than the sanctioned joins (the compact-r2 shape)', () => {
    const { findings } = scan(`${HELPER}
      declare function timed<T>(p: Promise<T>, deadline: number): Promise<T>;
      declare function joinSharedFlight<T>(p: Promise<T>, deadlineAt: number): Promise<T>;
      const pending = new Map<string, { deadlineAt: number; promise: Promise<string> }>();
      export async function viaTimed(key: string) {
        const entry = pending.get(key);
        if (entry) return timed(entry.promise, entry.deadlineAt);
      }
      export async function viaRace(key: string) {
        const entry = pending.get(key);
        if (entry) void Promise.race([entry.promise, read()]);
      }
      export async function sanctioned(key: string) {
        const entry = pending.get(key);
        if (entry) await joinSharedFlight(entry.promise, entry.deadlineAt);
        if (entry) await settleSharedFlight(entry.promise, entry.deadlineAt);
      }`);
    expect(findings.map((f) => [f.kind, f.code])).toEqual([
      ['hands-off', 'entry.promise'],
      ['hands-off', 'entry.promise'],
    ]);
  });

  it('honours a reviewed exception on the line above', () => {
    const { findings } = scan(`${HELPER}
      const ready: Promise<string> = read();
      export async function use() {
        // ${ALLOW_DIRECTIVE} settles in the same turn on every runtime
        return await ready;
      }`);
    expect(findings).toEqual([]);
  });
});

describe('shared-flight join guard CLI', () => {
  const script = resolve(import.meta.dirname, 'check-shared-flight-joins.ts');
  const run = (code: string) => {
    const file = join(mkdtempSync(join(tmpdir(), 'shared-flight-')), 'planted.ts');
    writeFileSync(file, code);
    return spawnSync('npx', ['tsx', script, '--file', file], { encoding: 'utf8' });
  };

  it('exits 1 and names the line for a planted violation, 0 for the sanctioned join', () => {
    const planted = run(`
      const pending = new Map<string, Promise<string>>();
      export async function join(key: string) { return await pending.get(key); }`);
    expect(planted.status, planted.stderr).toBe(1);
    expect(planted.stderr).toMatch(
      /planted\.ts:3 awaits a promise read from module-scope `pending`/
    );
    const clean = run(`
      const cached = new Map<string, string>();
      export async function read(key: string) { return cached.get(key); }`);
    expect(clean.status, clean.stderr).toBe(0);
    expect(clean.stdout).toMatch(/1 files, 0 finding\(s\)/);
  }, 120_000);
});
