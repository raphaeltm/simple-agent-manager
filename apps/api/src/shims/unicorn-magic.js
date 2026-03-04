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

export function toPath(urlOrPath) {
  return urlOrPath instanceof URL ? fileURLToPath(urlOrPath) : urlOrPath;
}

export function traversePathUp(startPath) {
  return {
    *[Symbol.iterator]() {
      let currentPath = path.resolve(toPath(startPath));
      let previousPath;

      while (previousPath !== currentPath) {
        yield currentPath;
        previousPath = currentPath;
        currentPath = path.resolve(currentPath, '..');
      }
    },
  };
}

export function rootDirectory(pathInput) {
  return path.parse(toPath(pathInput)).root;
}

export async function delay({ seconds, milliseconds } = {}) {
  let duration;
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
