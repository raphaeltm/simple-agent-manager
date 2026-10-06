import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Absolute path to `apps/api/src`. */
export const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src');

const SKIP_DIRECTORIES = new Set(['node_modules', 'dist', '.wrangler']);

/**
 * Recursively list every `.ts` source file under `root`, excluding tests and
 * build output.
 *
 * For architectural/enumeration tests that assert a property across all files of
 * a kind (e.g. "every workspace-provisioning path runs the branch guard"). Such
 * a test is only meaningful if the scan actually finds files, so callers should
 * assert a non-trivial expected minimum — see
 * `.claude/rules/02-quality-gates.md` ("a green test count is not a green suite").
 */
export function collectSourceFiles(root: string = SRC_ROOT): string[] {
  const files: string[] = [];

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRECTORIES.has(entry.name)) walk(path.join(dir, entry.name));
        continue;
      }
      if (!entry.name.endsWith('.ts') || entry.name.endsWith('.d.ts')) continue;
      if (entry.name.includes('.test.') || entry.name.includes('.spec.')) continue;
      files.push(path.join(dir, entry.name));
    }
  };

  walk(root);
  return files;
}
