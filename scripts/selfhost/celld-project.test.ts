import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import * as TOML from '@iarna/toml';
import { describe, expect, it } from 'vitest';

import type { WranglerToml } from '../deploy/types.js';
import { buildCelldConfig } from './celld-config.js';
import {
  CELLD_MAIN,
  listMigrationFiles,
  prepareCelldProject,
  renderCelldMain,
  writeCelldConfig,
} from './celld-project.js';

const API_DIR = resolve(import.meta.dirname, '../../apps/api');

function plan(assets = false) {
  const source = TOML.parse(readFileSync(join(API_DIR, 'wrangler.toml'), 'utf8')) as WranglerToml;
  return buildCelldConfig(source, {
    main: 'src/index.ts',
    baseDomain: 'sam.example.com',
    ...(assets ? { assetsDirectory: 'web' } : {}),
  });
}

function fakeWebDist(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sam-web-'));
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'index.html'), '<html></html>');
  writeFileSync(join(dir, '_headers'), '/oauth/consent\n  X-Frame-Options: DENY\n');
  writeFileSync(join(dir, 'assets', 'app.js'), 'x');
  writeFileSync(join(dir, 'assets', 'app.js.map'), '{}');
  return dir;
}

describe('prepareCelldProject', () => {
  it('writes the plain celld entry: the shared entry, the runtime switch and the self-host build', () => {
    const projectDir = join(mkdtempSync(join(tmpdir(), 'sam-celld-')), 'project');
    prepareCelldProject({ apiDir: API_DIR, projectDir, plan: plan() });
    const main = readFileSync(join(projectDir, CELLD_MAIN), 'utf8');
    expect(main).toBe(renderCelldMain());
    expect(main).toContain("import worker, { app } from './src/index.ts';");
    expect(main).toContain('resumeSharedFlightJoinsOnOwnTimer();');
    expect(main).toContain("export * from './src/index.ts';");
    expect(main).toContain('export default withSelfHostBuild(worker, app);');
    // Every module the entry imports exists in apps/api (the symlinked src).
    const specifiers = [...main.matchAll(/from '\.\/src\/([^']+)'/g)].map((m) => m[1]!);
    expect(specifiers.length).toBeGreaterThanOrEqual(3);
    for (const specifier of specifiers) {
      expect(existsSync(join(API_DIR, 'src', specifier)), specifier).toBe(true);
    }
    // Shared exports, the self-host-only DO, and the default.
    expect(main.match(/^export /gm)).toHaveLength(3);
    expect(statSync(join(projectDir, CELLD_MAIN)).mode & 0o777).toBe(0o600);
  });

  it('builds flat per-database migration dirs from the real migrations without moving them', () => {
    const projectDir = join(mkdtempSync(join(tmpdir(), 'sam-celld-')), 'project');
    const p = plan();
    prepareCelldProject({ apiDir: API_DIR, projectDir, plan: p });

    expect(readlinkSync(join(projectDir, 'src'))).toBe(join(API_DIR, 'src'));
    const main = listMigrationFiles(join(API_DIR, 'src/db/migrations'));
    const observability = listMigrationFiles(join(API_DIR, 'src/db/migrations/observability'));
    expect(main.length).toBeGreaterThan(200);
    expect(observability.length).toBeGreaterThan(0);

    const [mainDir, obsDir] = p.config.d1_databases.map((db) =>
      join(projectDir, db.migrations_dir)
    );
    // The primary database also carries the self-host-only reverse-tunnel lease migration, the
    // only source of node_reverse_tunnel_leases since the shared 0232 copy was removed.
    const leases = '0255_node_reverse_tunnel_leases.sql';
    expect(main).not.toContain(leases);
    expect(readdirSync(mainDir!).sort()).toEqual([...main, leases].sort());
    expect(readlinkSync(join(mainDir!, leases))).toBe(
      join(API_DIR, 'src/selfhost/migrations', leases)
    );
    // OBSERVABILITY_DATABASE likewise carries the self-host-only D1 analytics sink table,
    // which the shared observability directory (wrangler.toml) no longer holds.
    const analytics = '0002_analytics_events.sql';
    expect(observability).not.toContain(analytics);
    expect(readdirSync(obsDir!).sort()).toEqual([...observability, analytics].sort());
    expect(readlinkSync(join(obsDir!, analytics))).toBe(
      join(API_DIR, 'src/selfhost/migrations/observability', analytics)
    );
    // Flat: no subdirectory holding .sql files (celld refuses that), and links, not copies.
    for (const dir of [mainDir!, obsDir!]) {
      for (const entry of readdirSync(dir))
        expect(lstatSync(join(dir, entry)).isSymbolicLink()).toBe(true);
    }
    expect(existsSync(join(API_DIR, 'src/db/migrations/observability'))).toBe(true);
  });

  it('is idempotent and drops links to migrations that no longer exist', () => {
    const projectDir = join(mkdtempSync(join(tmpdir(), 'sam-celld-')), 'project');
    const p = plan();
    prepareCelldProject({ apiDir: API_DIR, projectDir, plan: p });
    const mainDir = join(projectDir, p.config.d1_databases[0]!.migrations_dir);
    writeFileSync(join(mainDir, '9999_stale.sql'), 'SELECT 1;');
    prepareCelldProject({ apiDir: API_DIR, projectDir, plan: p });
    expect(existsSync(join(mainDir, '9999_stale.sql'))).toBe(false);
  });

  it('refuses to replace a real directory where the src symlink belongs', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'sam-celld-'));
    mkdirSync(join(projectDir, 'src'));
    expect(() => prepareCelldProject({ apiDir: API_DIR, projectDir, plan: plan() })).toThrow(
      /not a symlink/
    );
  });

  it('copies the web build with _headers but without source maps', () => {
    const projectDir = join(mkdtempSync(join(tmpdir(), 'sam-celld-')), 'project');
    prepareCelldProject({ apiDir: API_DIR, projectDir, plan: plan(true), webDist: fakeWebDist() });
    expect(readFileSync(join(projectDir, 'web/_headers'), 'utf8')).toContain(
      'X-Frame-Options: DENY'
    );
    expect(existsSync(join(projectDir, 'web/assets/app.js'))).toBe(true);
    expect(existsSync(join(projectDir, 'web/assets/app.js.map'))).toBe(false);
  });

  it('refuses a web build containing a symlink', () => {
    const projectDir = join(mkdtempSync(join(tmpdir(), 'sam-celld-')), 'project');
    const dist = fakeWebDist();
    symlinkSync('/etc/hostname', join(dist, 'assets', 'leak.txt'));
    expect(() =>
      prepareCelldProject({ apiDir: API_DIR, projectDir, plan: plan(true), webDist: dist })
    ).toThrow(/is a symlink/);
  });

  it('writes the config root-only', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'sam-celld-'));
    const path = writeCelldConfig(projectDir, plan().config);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, 'utf8')).name).toBe('workspaces-api');
  });
});
