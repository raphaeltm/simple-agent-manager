/**
 * Materialise a celld project directory for `apps/api`.
 *
 * celld requires `main`, `assets.directory` and every D1 `migrations_dir` to sit inside the
 * project directory with no `..`, and reads migrations from flat directories only. The
 * repository keeps the observability migrations nested inside the main ones, so the project
 * gets one flat directory of symlinks per database. The real migration files are never moved.
 */

import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import type { CelldConfigPlan, CelldWranglerConfig } from './celld-config.js';
import { writePrivateFile } from './secret-files.js';

export const CONFIG_FILE = 'wrangler.json';
export const SOURCE_LINK = 'src';
export const ASSETS_DIR = 'web';

export interface PrepareProjectOptions {
  /** Absolute path to apps/api. */
  apiDir: string;
  /** Absolute path to the generated project directory. */
  projectDir: string;
  plan: CelldConfigPlan;
  /** Absolute path to the apps/web build output; copied into the project when set. */
  webDist?: string;
}

/** Points `link` at `target`, replacing a stale symlink but never a real file or directory. */
function ensureSymlink(target: string, link: string): void {
  if (existsSync(link) || isSymlink(link)) {
    if (!isSymlink(link))
      throw new Error(`${link} exists and is not a symlink; refusing to replace it`);
    if (readlinkSync(link) === target) return;
    rmSync(link);
  }
  symlinkSync(target, link);
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/** The .sql files directly inside `dir`, sorted; subdirectories are ignored. */
export function listMigrationFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.sql'))
    .map((entry) => entry.name)
    .sort();
}

export function prepareCelldProject(options: PrepareProjectOptions): void {
  const { apiDir, projectDir, plan } = options;
  mkdirSync(projectDir, { recursive: true, mode: 0o700 });
  ensureSymlink(resolve(apiDir, 'src'), join(projectDir, SOURCE_LINK));

  for (const dir of plan.migrationDirs) {
    const source = resolve(apiDir, dir.sourceDir);
    const files = listMigrationFiles(source);
    if (files.length === 0) throw new Error(`no .sql migrations in ${source}`);
    const target = join(projectDir, dir.projectRelativeDir);
    // Rebuilt every run so a deleted or renamed migration cannot linger as a stale link.
    rmSync(target, { recursive: true, force: true });
    mkdirSync(target, { recursive: true });
    for (const file of files) symlinkSync(join(source, file), join(target, file));
  }

  if (options.webDist) {
    if (!existsSync(join(options.webDist, 'index.html'))) {
      throw new Error(`${options.webDist} has no index.html; build apps/web first`);
    }
    const target = join(projectDir, ASSETS_DIR);
    const staging = `${target}.next`;
    rmSync(staging, { recursive: true, force: true });
    // Source maps stay out of the box: they triple the upload and the browser never needs them.
    cpSync(options.webDist, staging, {
      recursive: true,
      filter: (src) => !src.endsWith('.map'),
    });
    rmSync(target, { recursive: true, force: true });
    renameSync(staging, target);
  }
}

/** Writes the config with mode 0600; atomic so celld never reads a half-written file. */
export function writeCelldConfig(projectDir: string, config: CelldWranglerConfig): string {
  const path = join(projectDir, CONFIG_FILE);
  const temp = join(dirname(path), `.${CONFIG_FILE}.tmp`);
  writePrivateFile(temp, `${JSON.stringify(config, null, 2)}\n`);
  renameSync(temp, path);
  return path;
}
