/**
 * The Cloudflare build must not contain code only the self-host build needs (owner decision,
 * November 14, 2026: two builds rather than dormant code in production). It runs with the API unit
 * tests so any change under apps/api triggers it: an import added to any shared module could pull
 * the self-host-only code back into the Cloudflare bundle.
 *
 * - The shared entry `apps/api/src/index.ts` (wrangler.toml's `main`) must not reach
 *   `CLOUDFLARE_ENTRY_FORBIDDEN_PATHS`: the self-host-only code (`apps/api/src/selfhost/build.ts`
 *   included) and the operator tooling under `scripts/` (scripts/selfhost/ included).
 * - The generated celld entry (scripts/selfhost/celld-project.ts `renderCelldMain`) is what reaches
 *   them: it imports `selfhost/build.ts`, whose graph the walker must see, so this guard cannot
 *   pass because the walker went blind.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';

import * as TOML from '@iarna/toml';
import { describe, expect, it } from 'vitest';

import type { WranglerToml } from '../../../../../scripts/deploy/types';
import { renderCelldMain, SOURCE_LINK } from '../../../../../scripts/selfhost/celld-project';
import {
  API_SRC,
  CLOUDFLARE_ENTRY_FORBIDDEN_PATHS,
  collectImportGraph,
  GRAPH_WALK_TIMEOUT_MS,
  REPO_ROOT,
  selfhostOnlyFindings,
} from '../../helpers/selfhost-only-modules';

const SELFHOST_BUILD = 'apps/api/src/selfhost/build.ts';

/** The apps/api/src modules the generated celld entry imports, as absolute paths. */
function celldEntryImports(): string[] {
  const prefix = `./${SOURCE_LINK}/`;
  return [...renderCelldMain().matchAll(/from '([^']+)'/g)]
    .map((match) => match[1]!)
    .filter((specifier) => specifier.startsWith(prefix))
    .map((specifier) => resolve(API_SRC, specifier.slice(prefix.length)));
}

describe('self-host-only code stays out of the Cloudflare Worker', () => {
  it('detects real imports of the hosted DO, vendored git and pako', () => {
    const scratchRoot = resolve(REPO_ROOT, '.tmp');
    mkdirSync(scratchRoot, { recursive: true });
    const scratch = mkdtempSync(resolve(scratchRoot, 'hosted-git-graph-'));
    const entry = resolve(scratch, 'entry.ts');
    const doPath = 'apps/api/src/selfhost/hosted-git/hosted-git-repo.ts';
    try {
      writeFileSync(entry, `import '${relative(scratch, resolve(REPO_ROOT, doPath))}';`);
      const graph = collectImportGraph(entry);
      const findings = selfhostOnlyFindings(graph, CLOUDFLARE_ENTRY_FORBIDDEN_PATHS);
      expect(findings).toContain(doPath);
      expect(findings.some((path) => path.startsWith('apps/api/src/vendor/dgit/'))).toBe(true);
      expect(findings.some((path) => path.startsWith('package pako '))).toBe(true);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
    // The first graph walk in the file pays the cold TypeScript program: it timed out at the
    // 5 s default on a loaded runner (main CI 44899674095), like its siblings it needs the bound.
  }, GRAPH_WALK_TIMEOUT_MS);

  it('control: the actual metadata broker graph is forbidden to the Worker', () => {
    const graph = collectImportGraph(
      resolve(REPO_ROOT, 'deploy/selfhost/metadata-proxy/server.ts')
    );
    expect(graph.files).toContain('deploy/selfhost/metadata-proxy/token.ts');
    expect(selfhostOnlyFindings(graph, CLOUDFLARE_ENTRY_FORBIDDEN_PATHS)).toEqual(
      expect.arrayContaining([
        'deploy/selfhost/metadata-proxy/server.ts',
        'deploy/selfhost/metadata-proxy/token.ts',
        'deploy/selfhost/metadata-proxy/peer.ts',
      ])
    );
  });

  it(
    'the shared entry reaches no self-host-only module, package or script',
    { timeout: GRAPH_WALK_TIMEOUT_MS },
    () => {
      const toml = TOML.parse(
        readFileSync(resolve(REPO_ROOT, 'apps/api/wrangler.toml'), 'utf8')
      ) as unknown as WranglerToml;
      expect(toml.main).toBe('src/index.ts');
      const graph = collectImportGraph(resolve(API_SRC, 'index.ts'));
      // A walker that resolved nothing would pass the assertion below; the entry reaches well
      // over a thousand files.
      expect(graph.files.length).toBeGreaterThan(1000);
      expect(graph.files).not.toContain(SELFHOST_BUILD);
      expect(selfhostOnlyFindings(graph, CLOUDFLARE_ENTRY_FORBIDDEN_PATHS)).toEqual([]);
    }
  );

  it('control: the Cloudflare list forbids scripts/, which the self-host list allows', () => {
    // No real Worker file imports scripts/, so prove the prefix itself is live on a graph that does.
    const graph = {
      files: ['apps/api/src/index.ts', 'scripts/selfhost/secret-files.ts'],
      packages: new Map<string, string>(),
    };
    expect(selfhostOnlyFindings(graph, CLOUDFLARE_ENTRY_FORBIDDEN_PATHS)).toEqual([
      'scripts/selfhost/secret-files.ts',
    ]);
    expect(selfhostOnlyFindings(graph)).toEqual([]);
  });

  it(
    'positive control: the celld entry reaches the self-host build and its modules',
    { timeout: GRAPH_WALK_TIMEOUT_MS },
    () => {
      const imports = celldEntryImports();
      expect(imports).toContain(resolve(REPO_ROOT, SELFHOST_BUILD));
      const findings = imports.flatMap((entry) => selfhostOnlyFindings(collectImportGraph(entry)));
      expect(findings).toEqual(
        expect.arrayContaining([
          SELFHOST_BUILD,
          'apps/api/src/selfhost/analytics/index.ts',
          'apps/api/src/selfhost/speech/index.ts',
          'apps/api/src/selfhost/reverse-tunnel/entry.ts',
        ])
      );
    }
  );
});
