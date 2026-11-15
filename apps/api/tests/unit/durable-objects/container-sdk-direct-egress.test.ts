import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

// Bypass the API suite's lightweight Container alias to exercise the installed
// SDK's reconstruction path. cloudflare:workers still uses the Node test seam.
import { Container } from '../../../node_modules/@cloudflare/containers/dist/lib/container.js';

describe('installed Container SDK direct egress after reconstruction', () => {
  it('reconstructs a running guest without registering any outbound interceptors', async () => {
    const persisted = new Map();
    const interceptHttp = vi.fn();
    const interceptHttps = vi.fn();
    const interceptAll = vi.fn();
    const proxy = vi.fn(() => ({ fetch: vi.fn() }));
    const boot: Promise<unknown>[] = [];
    const ctx = {
      id: { toString: () => 'builder-job' },
      exports: { ContainerProxy: proxy },
      blockConcurrencyWhile: (fn: () => Promise<unknown>) => boot.push(fn()),
      storage: {
        sql: { exec: () => [] },
        kv: {
          get: (key: string) => persisted.get(key),
          put: (key: string, value: unknown) => persisted.set(key, value),
        },
        setAlarm: vi.fn(async () => {}),
        sync: vi.fn(async () => {}),
      },
      container: {
        running: true,
        monitor: () => new Promise(() => {}),
        interceptOutboundHttp: interceptHttp,
        interceptOutboundHttps: interceptHttps,
        interceptAllOutboundHttp: interceptAll,
      },
    };
    // Reconstruct twice, including the empty configuration persisted by the SDK.
    for (let i = 0; i < 2; i++) {
      const instance = new Container(ctx as unknown as DurableObjectState, {});
      await Promise.all(boot.splice(0));
      await (instance as unknown as { applyOutboundInterceptionPromise: Promise<void> })
        .applyOutboundInterceptionPromise;
      expect(instance.enableInternet).toBe(true);
    }
    expect(proxy).toHaveBeenCalledTimes(2);
    expect(interceptHttp).not.toHaveBeenCalled();
    expect(interceptHttps).not.toHaveBeenCalled();
    expect(interceptAll).not.toHaveBeenCalled();
  });

  it('exports the SDK helper from the Worker entrypoint for running-guest reconstruction', () => {
    const source = readFileSync(new URL('../../../src/index.ts', import.meta.url), 'utf8');
    expect(source).toMatch(
      /export\s*\{\s*ContainerProxy\s*\}\s*from\s*['"]@cloudflare\/containers['"]/
    );
  });
});
