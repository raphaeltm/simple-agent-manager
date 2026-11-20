/** Upgrade preflight for celld's tagless persisted deployment format (0.6.3).
 * The generated config retains the tags; cross-check it with the source translator AND the
 * active bucket manifest before trusting it. Never log a manifest: it contains Worker secrets.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { BoxContext } from './backup-lib';
import { bucketPath, mcArgs, mcEnv, parseBucketUrl } from './backup-lib';
import { assertOperatorExecution } from './operator-only.js';

export interface DoMigration {
  tag: string;
  new_sqlite_classes: string[];
}

const fail = (reason: string): never => {
  throw new Error(`DO migration preflight refused: ${reason}`);
};

export function migrationsFrom(value: unknown): DoMigration[] {
  if (!Array.isArray(value)) return fail('missing or invalid migration history');
  const tags = new Set<string>();
  const classes = new Set<string>();
  return value.map((entry: unknown) => {
    if (typeof entry !== 'object' || entry === null) return fail('invalid migration entry');
    const item = entry as Record<string, unknown>;
    if (typeof item.tag !== 'string' || !item.tag || tags.has(item.tag)) {
      return fail('missing or duplicate migration tag');
    }
    if (Object.keys(item).some((key) => !['tag', 'new_sqlite_classes'].includes(key))) {
      return fail('unsupported migration operation');
    }
    tags.add(item.tag);
    if (
      !Array.isArray(item.new_sqlite_classes) ||
      item.new_sqlite_classes.some((name) => typeof name !== 'string' || !name || classes.has(name))
    ) {
      return fail('invalid or duplicate SQLite class');
    }
    const names = item.new_sqlite_classes as string[];
    for (const name of names) {
      if (classes.has(name)) return fail('duplicate SQLite class');
      classes.add(name);
    }
    return { tag: item.tag, new_sqlite_classes: names };
  });
}

/** All existing tags and their class declarations are immutable; additions may occur between
 * existing tags (shared vN migrations precede the selfhost-only tags in generated configs).
 */
export function assertMigrationProgression(installed: DoMigration[], target: DoMigration[]): void {
  let last = -1;
  for (const migration of installed) {
    const index = target.findIndex((entry) => entry.tag === migration.tag);
    if (index < 0) fail('unknown or removed migration tag');
    if (index <= last) fail('out-of-order migration tags');
    if (
      JSON.stringify(migration.new_sqlite_classes) !==
      JSON.stringify(target[index]?.new_sqlite_classes)
    ) {
      fail('an existing migration changed its class declarations');
    }
    last = index;
  }
}

/** Runs the checkout's actual translator, so selfhost-only tags use the same source as deploy.
 * The probe has no box vars, secrets or deployment side effects; stdout contains only migrations.
 */
export function sourceMigrations(ctx: BoxContext): DoMigration[] {
  const result = ctx.run('pnpm', [
    'exec',
    'tsx',
    '--eval',
    [
      "import {readFileSync} from 'node:fs';",
      "import * as TOML from '@iarna/toml';",
      "import {buildCelldConfig} from './scripts/selfhost/celld-config.ts';",
      "const source=TOML.parse(readFileSync('apps/api/wrangler.toml','utf8'));",
      "const plan=buildCelldConfig(source,{main:'celld-main.ts',baseDomain:'upgrade.invalid'});",
      'process.stdout.write(JSON.stringify(plan.config.migrations));',
    ].join(''),
  ]);
  if (result.status !== 0) fail('cannot read checkout migration declarations');
  try {
    return migrationsFrom(JSON.parse(result.stdout));
  } catch {
    return fail('invalid checkout migration declarations');
  }
}

/** Read only the exact celld control objects, and never surface their contents or stderr. */
function readControlObject(ctx: BoxContext, key: string): Record<string, unknown> {
  assertOperatorExecution();
  const url = parseBucketUrl(ctx.box.CELLD_BUCKET ?? '');
  const result =
    url.scheme === 'gs'
      ? ctx.run('gcloud', ['storage', 'cat', `gs://${bucketPath(url)}/${key}`])
      : ctx.run('docker', mcArgs(ctx, [], ['cat', `src/${bucketPath(url)}/${key}`]), mcEnv(ctx));
  if (result.status !== 0) fail('cannot read active deployment state');
  try {
    const object: unknown = JSON.parse(result.stdout);
    if (typeof object !== 'object' || object === null || Array.isArray(object))
      fail('invalid active deployment state');
    return object as Record<string, unknown>;
  } catch {
    return fail('invalid active deployment state');
  }
}

export function installedMigrations(ctx: BoxContext): DoMigration[] {
  assertOperatorExecution();
  let config: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(join(ctx.stateDir, 'project', 'wrangler.json'), 'utf8')
    );
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
      fail('invalid installed generated config');
    config = parsed as Record<string, unknown>;
  } catch {
    return fail('missing installed generated config; deploy the current checkout before upgrading');
  }
  const installed = migrationsFrom(config.migrations);
  const source = sourceMigrations(ctx);
  // An incomplete/edited local config cannot attest the migration state of this checkout.
  if (JSON.stringify(installed) !== JSON.stringify(source))
    fail('installed tags differ from the current checkout');
  const pointer = readControlObject(ctx, 'deploy/current.json');
  if (
    typeof pointer.script_name !== 'string' ||
    typeof pointer.version !== 'string' ||
    !/^[a-zA-Z0-9_-]+$/.test(pointer.script_name) ||
    !/^[a-zA-Z0-9_-]+$/.test(pointer.version) ||
    pointer.prefix !== `deploy/${pointer.script_name}/${pointer.version}` ||
    pointer.script_name !== config.name
  ) {
    fail('active deployment pointer does not match the installation');
  }
  const manifest = readControlObject(ctx, `${pointer.prefix}/manifest.json`);
  if (
    manifest.script_name !== pointer.script_name ||
    manifest.version !== pointer.version ||
    !Array.isArray(manifest.sqlite_classes) ||
    manifest.sqlite_classes.some((name) => typeof name !== 'string')
  ) {
    fail('active deployment manifest does not match its pointer');
  }
  // celld's reserved runtime classes are injected after the declared application classes.
  const applicationClasses = (manifest.sqlite_classes as string[]).filter(
    (name) =>
      !['__D1Database', '__KvNamespace', '__Queue', '__Workflow'].includes(name) &&
      !name.startsWith('__Workflow.')
  );
  const expectedClasses = installed.flatMap((entry) => entry.new_sqlite_classes);
  if (JSON.stringify(applicationClasses) !== JSON.stringify(expectedClasses)) {
    fail('active deployment classes differ from installed migration declarations');
  }
  return installed;
}
