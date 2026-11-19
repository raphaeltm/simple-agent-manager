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
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import * as TOML from '@iarna/toml';
import { describe, expect, it } from 'vitest';

import type { WranglerToml } from '../../../../../scripts/deploy/types';
import { renderCelldMain, SOURCE_LINK } from '../../../../../scripts/selfhost/celld-project';
import {
  API_SRC,
  CLOUDFLARE_ENTRY_FORBIDDEN_PATHS,
  collectImportGraph,
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
  it('the shared entry reaches no self-host-only module, package or script', () => {
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
  });

  it('positive control: the celld entry reaches the self-host build and its modules', () => {
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
  });
});
