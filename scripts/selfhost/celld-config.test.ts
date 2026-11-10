import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import * as TOML from '@iarna/toml';
import { describe, expect, it } from 'vitest';

import type { WranglerToml } from '../deploy/types.js';
import { buildCelldConfig, SELFHOST_VAR_OVERRIDES } from './celld-config.js';

const WRANGLER_TOML = resolve(import.meta.dirname, '../../apps/api/wrangler.toml');

/** celld 0.6.x's accepted top-level keys (celld docs, configuration reference). */
const CELLD_TOP_LEVEL_KEYS = new Set([
  'name', 'main', 'no_bundle', 'compatibility_date', 'compatibility_flags', 'durable_objects',
  'migrations', 'assets', 'services', 'triggers', 'vars', 'd1_databases', 'kv_namespaces',
  'queues', 'workflows', 'r2_buckets', 'worker_loaders', 'containers', 'define', 'rules',
]);

function loadToml(): WranglerToml {
  return TOML.parse(readFileSync(WRANGLER_TOML, 'utf8')) as WranglerToml;
}

const options = { main: 'src/index.ts', baseDomain: 'sam.example.com' };

describe('buildCelldConfig against the real apps/api/wrangler.toml', () => {
  const source = loadToml();
  const plan = buildCelldConfig(source, { ...options, assetsDirectory: 'web' });
  const { config } = plan;

  it('emits only keys celld accepts', () => {
    for (const key of Object.keys(config)) expect(CELLD_TOP_LEVEL_KEYS.has(key)).toBe(true);
  });

  it('drops every Cloudflare-only key and reports why', () => {
    for (const key of ['port', 'limits', 'alias', 'artifacts', 'analytics_engine_datasets', 'ai', 'containers']) {
      expect(config).not.toHaveProperty(key);
      expect(plan.report.some((line) => line.startsWith(`drop [${key}]`))).toBe(true);
    }
  });

  it('folds every legacy new_classes create into new_sqlite_classes, keeping tag order', () => {
    const sourceMigrations = source.migrations as Array<{ tag: string; new_classes?: string[]; new_sqlite_classes?: string[] }>;
    expect(sourceMigrations.some((m) => m.new_classes?.length)).toBe(true);
    expect(config.migrations.map((m) => m.tag)).toEqual(sourceMigrations.map((m) => m.tag));
    for (const migration of config.migrations) {
      expect(Object.keys(migration).sort()).toEqual(['new_sqlite_classes', 'tag']);
    }
    const created = config.migrations.flatMap((m) => m.new_sqlite_classes);
    const expected = sourceMigrations.flatMap((m) => [...(m.new_sqlite_classes ?? []), ...(m.new_classes ?? [])]);
    expect(new Set(created)).toEqual(new Set(expected));
  });

  it('keeps container DO bindings (the classes stay exported) but not their containers', () => {
    const classes = config.durable_objects.bindings.map((b) => b.class_name);
    expect(classes).toContain('SandboxDO');
    expect(classes).toContain('VmAgentContainer');
  });

  it('gives every R2 binding a distinct bucket and points R2_BUCKET_NAME at the R2 binding', () => {
    const names = config.r2_buckets.map((b) => b.bucket_name);
    expect(new Set(names).size).toBe(names.length);
    const r2 = config.r2_buckets.find((b) => b.binding === 'R2')!;
    expect(config.vars.R2_BUCKET_NAME).toBe(r2.bucket_name);
  });

  it('plans one flat migrations directory per database inside the project', () => {
    expect(config.d1_databases).toHaveLength(2);
    for (const db of config.d1_databases) {
      expect(db.migrations_dir.startsWith('d1-migrations/')).toBe(true);
      expect(db.migrations_dir.split('/')).not.toContain('..');
    }
    expect(plan.migrationDirs.map((d) => d.sourceDir)).toEqual([
      'src/db/migrations',
      'src/db/migrations/observability',
    ]);
    // Distinct dirs even though one source is nested inside the other.
    expect(new Set(config.d1_databases.map((d) => d.migrations_dir)).size).toBe(2);
  });

  it('keeps the cron triggers', () => {
    expect(config.triggers.crons).toEqual((source.triggers as { crons: string[] }).crons);
    expect(config.triggers.crons.length).toBeGreaterThan(0);
  });

  it('turns the Cloudflare-only switches off and sets BASE_DOMAIN', () => {
    for (const [key, value] of Object.entries(SELFHOST_VAR_OVERRIDES)) expect(config.vars[key]).toBe(value);
    expect(config.vars.CF_CONTAINER_ENABLED).toBe('false');
    expect(config.vars.BASE_DOMAIN).toBe('sam.example.com');
    // Ordinary tunables still flow through from wrangler.toml [vars].
    expect(config.vars.MAX_NODES_PER_USER).toBe((source.vars as Record<string, string>).MAX_NODES_PER_USER);
  });

  it('serves the web build through ASSETS with SPA fallback, Worker first', () => {
    expect(config.assets).toEqual({
      directory: 'web',
      binding: 'ASSETS',
      not_found_handling: 'single-page-application',
      run_worker_first: true,
    });
    expect(config.main).toBe('src/index.ts');
  });

  it('does not mutate the parsed wrangler.toml', () => {
    expect(loadToml()).toEqual(source);
  });
});

describe('buildCelldConfig failure modes', () => {
  const base = (): WranglerToml => loadToml();

  it('fails loudly on a top-level key it has no rule for', () => {
    for (const key of ['routes', 'tail_consumers', 'observability', 'env', 'send_email', 'workers_dev']) {
      const source = { ...base(), [key]: [] };
      expect(() => buildCelldConfig(source, options)).toThrow(new RegExp(`no self-host translation: ${key}`));
    }
  });

  it('fails on a binding field it does not translate', () => {
    const source = base();
    (source.d1_databases as Array<Record<string, unknown>>)[0]!.preview_database_id = 'x';
    expect(() => buildCelldConfig(source, options)).toThrow(/d1_databases\[0\] has keys .*preview_database_id/);
  });

  it('fails on a Durable Object migration celld cannot apply', () => {
    const source = base();
    (source.migrations as unknown[]).push({ tag: 'v999', renamed_classes: [{ from: 'A', to: 'B' }] });
    expect(() => buildCelldConfig(source, options)).toThrow(/migration v999 uses renamed_classes/);
  });

  it('refuses caller vars for keys the generator owns', () => {
    expect(() => buildCelldConfig(base(), { ...options, vars: { BASE_DOMAIN: 'evil.example' } })).toThrow(
      /vars.BASE_DOMAIN is generated/
    );
  });

  it('refuses an assets directory outside the project', () => {
    expect(() => buildCelldConfig(base(), { ...options, assetsDirectory: '../web' })).toThrow(/no \.\./);
  });

  it('omits assets when no web build is given', () => {
    expect(buildCelldConfig(base(), options).config).not.toHaveProperty('assets');
  });
});
