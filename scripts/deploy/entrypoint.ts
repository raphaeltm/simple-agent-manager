/**
 * Whether the module at `importMetaUrl` is the script node (or tsx) was asked to run. Both sides
 * are compared as real paths: node resolves symlinks for the main module's `import.meta.url`,
 * while `process.argv[1]` keeps the path as typed, so a symlinked checkout or a path that needs
 * URL escaping (a space) would otherwise never match and the CLI would silently do nothing.
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function isEntrypoint(importMetaUrl: string): boolean {
  const script = process.argv[1];
  if (!script) return false;
  try {
    return realpathSync(script) === realpathSync(fileURLToPath(importMetaUrl));
  } catch {
    return false;
  }
}
