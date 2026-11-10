#!/usr/bin/env node
// Throwaway spike script: translate apps/api/wrangler.toml into a celld-acceptable
// wrangler.json. celld v0.6.2 accepts only these top-level keys (unknown keys stop
// the deploy): name, main, no_bundle, compatibility_date, compatibility_flags,
// durable_objects, migrations, assets, services, triggers, vars, d1_databases,
// kv_namespaces, queues, workflows, r2_buckets, worker_loaders, containers, define, rules.
//
// Usage:
//   node gen-wrangler-json.mjs --out <projectDir> [--main <relative main>] [--keep-containers]
//        [--no-bundle] [--secrets <dotenv file>]
//
// Writes <projectDir>/wrangler.json and prints a report of every dropped/translated key.
import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, symlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve, relative, dirname } from 'node:path';

const repo = resolve(dirname(new URL(import.meta.url).pathname), '../../..');
const require = createRequire(resolve(repo, 'scripts/deploy/package.json'));
const TOML = require('@iarna/toml');

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
};
const flag = (name) => args.includes(name);

const outDir = resolve(opt('--out', resolve(repo, '.tmp/celld-project')));
const keepContainers = flag('--keep-containers');
const noBundle = flag('--no-bundle');
const mainOverride = opt('--main');
const secretsFile = opt('--secrets');

const src = TOML.parse(readFileSync(resolve(repo, 'apps/api/wrangler.toml'), 'utf8'));
const apiDir = resolve(repo, 'apps/api');
const report = [];

const ALLOWED = new Set([
  'name', 'main', 'no_bundle', 'compatibility_date', 'compatibility_flags', 'durable_objects',
  'migrations', 'assets', 'services', 'triggers', 'vars', 'd1_databases', 'kv_namespaces',
  'queues', 'workflows', 'r2_buckets', 'worker_loaders', 'containers', 'define', 'rules',
]);

const out = {};
for (const [k, v] of Object.entries(src)) {
  if (ALLOWED.has(k)) out[k] = v;
  else report.push(`DROP top-level key [${k}] (${JSON.stringify(v).slice(0, 80)})`);
}

// main: relative to the generated project dir.
out.main = mainOverride ?? relative(outDir, resolve(apiDir, src.main));
if (noBundle) out.no_bundle = true;

const CONTAINER_CLASSES = new Set((src.containers ?? []).map((c) => c.class_name));
if (!keepContainers) {
  delete out.containers;
  report.push(`DROP [[containers]] ${[...CONTAINER_CLASSES].join(', ')} (classes stay exported by index.ts)`);
  // Keep the DO bindings for the container classes: they are plain DO classes to celld.
} else if (out.containers) {
  out.containers = out.containers.map((c) => ({ ...c, image: relative(outDir, resolve(apiDir, c.image)) }));
}

// Migrations: celld only accepts tag + new_sqlite_classes. Fold legacy new_classes into
// new_sqlite_classes (what scripts/deploy/durable-object-migrations.ts does for a clean install).
out.migrations = (src.migrations ?? []).map((m) => {
  const extra = Object.keys(m).filter((k) => !['tag', 'new_sqlite_classes', 'new_classes'].includes(k));
  if (extra.length) throw new Error(`migration ${m.tag} has unsupported keys ${extra}`);
  const classes = [...(m.new_sqlite_classes ?? []), ...(m.new_classes ?? [])];
  if (m.new_classes?.length) report.push(`TRANSLATE migration ${m.tag}: new_classes ${m.new_classes} -> new_sqlite_classes`);
  return { tag: m.tag, new_sqlite_classes: classes };
});

// Every migrated class must be exported. Classes created by migrations but no longer bound
// (retired trial DOs) still need an export; index.ts keeps tombstones for them.

// D1: celld needs migrations_dir relative to the project dir.
// celld requires migrations_dir to be a relative path INSIDE the project with no `..`.
// With --main (project dir mirrors apps/api via a `src` symlink), keep the toml paths as-is.
// celld also refuses a migrations_dir that has a subdirectory holding .sql files
// (SAM nests src/db/migrations/observability inside src/db/migrations). So each database
// gets a flat project-local directory of symlinks to its own .sql files.
out.d1_databases = (src.d1_databases ?? []).map((d) => {
  const flat = `d1-migrations/${d.binding.toLowerCase()}`;
  const from = resolve(apiDir, d.migrations_dir);
  const to = resolve(outDir, flat);
  rmSync(to, { recursive: true, force: true });
  mkdirSync(to, { recursive: true });
  const files = readdirSync(from).filter((f) => f.toLowerCase().endsWith('.sql'));
  for (const f of files) symlinkSync(resolve(from, f), resolve(to, f));
  report.push(`TRANSLATE d1 ${d.binding}: migrations_dir ${d.migrations_dir} -> ${flat} (${files.length} flat symlinks)`);
  return { ...d, migrations_dir: flat };
});

// celld rejects two r2 bindings that name the same bucket. SAM binds R2 and
// PROJECT_DATA_ARCHIVE_R2 to ONE bucket (also in production: sync-wrangler-config.ts uses
// outputs.r2Name for both) and separates them by key prefix. Give later duplicates a
// distinct bucket name.
{
  const seen = new Set();
  out.r2_buckets = (out.r2_buckets ?? []).map((b) => {
    if (!seen.has(b.bucket_name)) { seen.add(b.bucket_name); return b; }
    const renamed = `${b.bucket_name}-${b.binding.toLowerCase().replaceAll('_', '-')}`;
    report.push(`TRANSLATE r2 binding ${b.binding}: duplicate bucket ${b.bucket_name} -> ${renamed}`);
    seen.add(renamed);
    return { ...b, bucket_name: renamed };
  });
}

// Secrets: throwaway values merged into vars (celld has no secret store for real nodes;
// `celld dev` may read .dev.vars but we keep everything in one place for the spike).
if (secretsFile) {
  const text = readFileSync(secretsFile, 'utf8');
  const secrets = JSON.parse(text);
  out.vars = { ...(out.vars ?? {}), ...secrets };
  report.push(`MERGE ${Object.keys(secrets).length} throwaway secrets into vars (plaintext)`);
}

// --probe: wire the spike-only SpikeProbeDO (apps/api/src/spike-probe.ts) and enable /__spike.
if (flag('--probe')) {
  out.durable_objects.bindings.push({ name: 'SPIKE_PROBE_DO', class_name: 'SpikeProbeDO' });
  const last = out.migrations.at(-1).tag;
  out.migrations.push({ tag: `v${Number(last.slice(1)) + 1}`, new_sqlite_classes: ['SpikeProbeDO'] });
  out.vars = { ...out.vars, SPIKE_PROBE: 'true' };
  report.push('ADD SpikeProbeDO binding + migration, SPIKE_PROBE=true');
}

// --var NAME=VALUE (repeatable): override/add plain vars (e.g. feature flags for self-host).
for (let i = 0; i < args.length; i++) {
  if (args[i] !== '--var') continue;
  const [k, ...rest] = args[i + 1].split('=');
  out.vars = { ...out.vars, [k]: rest.join('=') };
  report.push(`VAR ${k}=${rest.join('=')}`);
}

mkdirSync(outDir, { recursive: true });
writeFileSync(resolve(outDir, 'wrangler.json'), JSON.stringify(out, null, 2) + '\n');
console.log(`wrote ${resolve(outDir, 'wrangler.json')}`);
for (const line of report) console.log('  ' + line);
