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

  it('does not treat a call on a module-scope object as joining its state', () => {
    const { findings } = scan(`${HELPER}
      class Cache { private flight?: Promise<string>; async read() { return (this.flight ??= read()); } }
      const cache = new Cache();
      export async function use() { return await cache.read(); }`);
    expect(findings).toEqual([]);
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
