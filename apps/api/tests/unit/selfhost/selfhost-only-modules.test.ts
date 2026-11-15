/**
 * The Cloudflare build must not contain code or storage classes only the self-host build needs
 * (owner decision, November 14, 2026: two builds rather than dormant code in production). It runs
 * with the API unit tests so any change under apps/api triggers it: an import added to any shared
 * module could pull the self-host-only code back into the Cloudflare bundle.
 *
 * - The shared entry `apps/api/src/index.ts` must not reach `SELFHOST_ONLY_PATHS` or pako.
 * - `apps/api/wrangler.toml` must not declare a self-host-only binding, class or migration.
 * - The generated celld config must still declare them, and the self-host module must still
 *   reach the Durable Object, so this guard cannot pass because the walker went blind.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import * as TOML from '@iarna/toml';
import { describe, expect, it } from 'vitest';

import type { WranglerToml } from '../../../../../scripts/deploy/types';
import { buildCelldConfig } from '../../../../../scripts/selfhost/celld-config';
import { SELFHOST_DURABLE_OBJECTS } from '../../../../../scripts/selfhost/selfhost-durable-objects';
import {
  API_SRC,
  collectImportGraph,
  REPO_ROOT,
  selfhostOnlyFindings,
} from '../../helpers/selfhost-only-modules';

const WRANGLER_TOML = resolve(REPO_ROOT, 'apps/api/wrangler.toml');

function loadWranglerToml(): WranglerToml {
  return TOML.parse(readFileSync(WRANGLER_TOML, 'utf8')) as unknown as WranglerToml;
}

describe('self-host-only code stays out of the Cloudflare Worker', () => {
  it('the shared entry reaches no self-host-only module or package', () => {
    const graph = collectImportGraph(resolve(API_SRC, 'index.ts'));
    // A walker that resolved nothing would pass the assertion below; the entry reaches well
    // over a thousand files.
    expect(graph.files.length).toBeGreaterThan(1000);
    expect(selfhostOnlyFindings(graph)).toEqual([]);
  });

  it('the self-host module reaches the Durable Object, dgit and pako (the walker can see them)', () => {
    const findings = selfhostOnlyFindings(
      collectImportGraph(resolve(API_SRC, 'selfhost/hosted-git.ts'))
    );
    expect(findings).toEqual(
      expect.arrayContaining([
        'apps/api/src/durable-objects/hosted-git-repo.ts',
        'apps/api/src/vendor/dgit/git/zlib.ts',
        'package pako (imported by apps/api/src/vendor/dgit/git/packstore.ts)',
      ])
    );
  });

  it('wrangler.toml declares no self-host-only binding, class or migration', () => {
    const toml = loadWranglerToml();
    const bindings = toml.durable_objects?.bindings ?? [];
    const migrations = toml.migrations ?? [];
    for (const object of SELFHOST_DURABLE_OBJECTS) {
      expect(bindings.map((b) => b.name)).not.toContain(object.binding);
      expect(bindings.map((b) => b.class_name)).not.toContain(object.className);
      expect(migrations.map((m) => m.tag)).not.toContain(object.migrationTag);
      expect(
        migrations.flatMap((m) => [...(m.new_sqlite_classes ?? []), ...(m.new_classes ?? [])])
      ).not.toContain(object.className);
    }
  });

  it('the celld config declares every self-host-only binding and migration', () => {
    const { config } = buildCelldConfig(loadWranglerToml(), {
      main: 'celld-main.ts',
      baseDomain: 'box.example.com',
    });
    for (const object of SELFHOST_DURABLE_OBJECTS) {
      expect(config.durable_objects.bindings).toContainEqual({
        name: object.binding,
        class_name: object.className,
      });
      expect(config.migrations).toContainEqual({
        tag: object.migrationTag,
        new_sqlite_classes: [object.className],
      });
    }
  });
});
