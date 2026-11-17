/**
 * The self-host speech backend (src/selfhost/speech/) must not reach the Cloudflare bundle.
 *
 * Walks the static and dynamic imports of the shared Worker entry (src/index.ts) the way the
 * bundler resolves them and asserts none lands under src/selfhost/. Type-only imports count too:
 * erring towards a false alarm is cheaper than shipping the code. A positive control walks the
 * self-host module itself, so an empty or broken walk cannot pass as "all clear".
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const API_ROOT = resolve(import.meta.dirname, '../../..');
const SELFHOST_DIR = 'src/selfhost/';

function isFile(path: string): boolean {
  return existsSync(path) && statSync(path).isFile();
}

function resolveRelative(fromFile: string, specifier: string): string {
  const base = resolve(dirname(fromFile), specifier).replace(/\.(m?js)$/, '');
  const found = [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`].find(isFile);
  if (!found) throw new Error(`cannot resolve ${specifier} from ${relative(API_ROOT, fromFile)}`);
  return found;
}

/** API-relative paths of every source file reachable from `entry` through relative imports. */
function reachableFiles(entry: string): string[] {
  const seen = new Set<string>();
  const pending = [resolve(API_ROOT, entry)];
  while (pending.length > 0) {
    const file = pending.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    if (!/\.tsx?$/.test(file)) continue;
    const info = ts.preProcessFile(readFileSync(file, 'utf8'), true, true);
    for (const { fileName } of info.importedFiles) {
      if (fileName.startsWith('.')) pending.push(resolveRelative(file, fileName));
    }
  }
  return [...seen].map((file) => relative(API_ROOT, file));
}

describe('self-host speech backend stays out of the Cloudflare Worker', () => {
  it('the shared entry src/index.ts reaches no file under src/selfhost/', () => {
    const files = reachableFiles('src/index.ts');
    // A real walk of the Worker covers hundreds of modules, including the speech seam.
    expect(files.length).toBeGreaterThan(300);
    expect(files).toContain('src/services/speech-backend.ts');
    expect(files.filter((file) => file.startsWith(SELFHOST_DIR))).toEqual([]);
  });

  it('positive control: the self-host module is found when walked directly', () => {
    const files = reachableFiles('src/selfhost/speech/index.ts');
    expect(files).toEqual(
      expect.arrayContaining([
        'src/selfhost/speech/index.ts',
        'src/selfhost/speech/endpoints.ts',
        'src/selfhost/speech/settings.ts',
        'src/services/speech-backend.ts',
      ])
    );
  });
});
