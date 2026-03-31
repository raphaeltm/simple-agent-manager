/**
 * Shim for unicorn-magic that provides the "node" condition exports.
 *
 * unicorn-magic@0.3.0 has conditional exports:
 *   "node"    → node.js    (toPath, traversePathUp, execFile, etc.)
 *   "default" → default.js (only delay)
 *
 * Wrangler's esbuild resolves the "default" condition, which breaks the
 * @mastra/core → execa → npm-run-path → unicorn-magic import chain because
 * npm-run-path imports { toPath, traversePathUp } from 'unicorn-magic'.
 *
 * This shim provides the Node-condition exports so the alias in wrangler.toml
 * can point here. nodejs_compat is enabled, so node:path and node:url are
 * available at runtime.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function toPath(urlOrPath: URL | string): string {
  return urlOrPath instanceof URL ? fileURLToPath(urlOrPath) : urlOrPath;
}

interface TraversePathUpIterable {
  [Symbol.iterator](): Generator<string>;
}

export function traversePathUp(startPath: URL | string): TraversePathUpIterable {
  return {
    *[Symbol.iterator]() {
      let currentPath = path.resolve(toPath(startPath));
      let previousPath: string | undefined;

      while (previousPath !== currentPath) {
        yield currentPath;
        previousPath = currentPath;
        currentPath = path.resolve(currentPath, '..');
      }
    },
  };
}

export function rootDirectory(pathInput: URL | string): string {
  return path.parse(toPath(pathInput)).root;
}

interface DelayOptions {
  seconds?: number;
  milliseconds?: number;
}

export async function delay({ seconds, milliseconds }: DelayOptions = {}): Promise<void> {
  let duration: number;
  if (typeof seconds === 'number') {
    duration = seconds * 1000;
  } else if (typeof milliseconds === 'number') {
    duration = milliseconds;
  } else {
    throw new TypeError(
      'Expected an object with either `seconds` or `milliseconds`.',
    );
  }

  return new Promise((resolve) => {
    setTimeout(resolve, duration);
  });
}
