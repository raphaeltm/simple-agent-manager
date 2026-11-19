import { expect, it, vi } from 'vitest';

import { memoizeRouteImport } from '../../src/lib/lazy-with-retry';

it('shares a pending import and keeps successful preloads for later route rendering', async () => {
  let finish!: (value: string) => void;
  const importModule = vi.fn(
    () =>
      new Promise<string>((resolve) => {
        finish = resolve;
      })
  );
  const load = memoizeRouteImport(importModule);
  const preload = load();
  expect(load()).toBe(preload);
  finish('module');
  await expect(preload).resolves.toBe('module');
  await expect(load()).resolves.toBe('module');
  expect(importModule).toHaveBeenCalledOnce();
});

it('allows chunk recovery to invoke the importer again after a rejected preload', async () => {
  const failure = new TypeError('Failed to fetch dynamically imported module');
  const importModule = vi.fn().mockRejectedValueOnce(failure).mockResolvedValue('recovered module');
  const load = memoizeRouteImport(importModule);
  await expect(load()).rejects.toBe(failure);
  await expect(load()).resolves.toBe('recovered module');
  expect(importModule).toHaveBeenCalledTimes(2);
});
