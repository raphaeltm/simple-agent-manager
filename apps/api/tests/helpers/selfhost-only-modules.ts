/**
 * Which self-host-only modules a Worker entry reaches through its static and dynamic imports.
 *
 * The Cloudflare Worker's entry is `apps/api/src/index.ts`. Code only the single-VM self-host
 * build needs (the HostedGitRepo Durable Object, the vendored dgit core and pako 2, everything
 * under `src/selfhost/`) is imported only by the celld entry that scripts/selfhost/celld-project.ts
 * generates. If the shared entry's import graph reaches any of it, the Cloudflare bundle carries
 * it again. tests/unit/selfhost/selfhost-only-modules.test.ts runs this against the real entry.
 *
 * Every specifier `ts.preProcessFile` reports counts, type-only imports included: erring towards
 * a false alarm is cheaper than shipping the code. Workspace packages (`@simple-agent-manager/*`)
 * are not descended into; none of them imports these modules or pako.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';

import ts from 'typescript';

export const REPO_ROOT = resolve(import.meta.dirname, '../../../..');
export const API_SRC = resolve(REPO_ROOT, 'apps/api/src');

/** Repository-relative path prefixes only the self-host build may contain. */
export const SELFHOST_ONLY_PATHS: readonly string[] = [
  'apps/api/src/selfhost/',
  // hosted-git-repo.ts, hosted-git-gc.ts, hosted-git-ls-refs.ts and any file split out of them.
  'apps/api/src/durable-objects/hosted-git-',
  'apps/api/src/vendor/dgit/',
];

/**
 * Repository-relative path prefixes the Cloudflare Worker's entry must not reach: the self-host-only
 * code, plus `scripts/` (deploy and packaging tooling, scripts/selfhost/ included), which runs on
 * an operator's machine with node APIs and never belongs in any Worker bundle.
 */
export const CLOUDFLARE_ENTRY_FORBIDDEN_PATHS: readonly string[] = [
  ...SELFHOST_ONLY_PATHS,
  'scripts/',
  'deploy/selfhost/',
];

/** npm packages only the self-host build may import (pako 2 is dgit's compression library). */
export const SELFHOST_ONLY_PACKAGES: readonly string[] = ['pako'];

export interface ImportGraph {
  /** Repository-relative paths of every source file reached, the entry included. */
  files: string[];
  /** Bare package specifiers reached, mapped to the first file that imports each one. */
  packages: Map<string, string>;
}

function isFile(path: string): boolean {
  return existsSync(path) && statSync(path).isFile();
}

/** Resolves a relative specifier the way the bundler does for this tree (.ts, .tsx, index.ts). */
function resolveRelative(fromFile: string, specifier: string): string {
  const base = resolve(dirname(fromFile), specifier);
  const withoutJs = base.replace(/\.(m?js)$/, '');
  const candidates = [base, `${withoutJs}.ts`, `${withoutJs}.tsx`, `${base}/index.ts`];
  const found = candidates.find(isFile);
  if (!found) throw new Error(`cannot resolve ${specifier} from ${relative(REPO_ROOT, fromFile)}`);
  return found;
}

/** `@scope/name/sub` -> `@scope/name`; `name/sub` -> `name`. */
function packageName(specifier: string): string {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? specifier);
}

export function collectImportGraph(entry: string): ImportGraph {
  const seen = new Set<string>();
  const packages = new Map<string, string>();
  const pending = [resolve(entry)];
  while (pending.length > 0) {
    const file = pending.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    if (!/\.tsx?$/.test(file)) continue;
    const info = ts.preProcessFile(readFileSync(file, 'utf8'), true, true);
    for (const { fileName: specifier } of info.importedFiles) {
      if (specifier.startsWith('.')) {
        pending.push(resolveRelative(file, specifier));
      } else {
        const name = packageName(specifier);
        if (!packages.has(name)) packages.set(name, relative(REPO_ROOT, file));
      }
    }
  }
  const files = [...seen]
    .map((file) => relative(REPO_ROOT, file))
    .sort((a, b) => {
      if (a < b) return -1;
      return a > b ? 1 : 0;
    });
  return { files, packages };
}

/**
 * Every self-host-only file and package `graph` reaches, as human-readable findings. `paths` are
 * the forbidden file prefixes (`CLOUDFLARE_ENTRY_FORBIDDEN_PATHS` for the Cloudflare entry).
 */
export function selfhostOnlyFindings(
  graph: ImportGraph,
  paths: readonly string[] = SELFHOST_ONLY_PATHS
): string[] {
  const files = graph.files.filter((file) => paths.some((p) => file.startsWith(p)));
  const packages = SELFHOST_ONLY_PACKAGES.filter((name) => graph.packages.has(name)).map(
    (name) => `package ${name} (imported by ${graph.packages.get(name)})`
  );
  return [...files, ...packages];
}
