/**
 * The generated self-host project bundles on celld with hosted git in it.
 *
 * The celld config and entry come from scripts/selfhost (celld-config.ts, celld-project.ts) and
 * the real apps/api/wrangler.toml, exactly as `pnpm selfhost:deploy` writes them. The pinned celld
 * then bundles each one with `celld deploy --dry-run`, which builds the Worker with esbuild and
 * prints every binding without touching a bucket. This catches what the Cloudflare-side guard
 * (tests/unit/selfhost/selfhost-only-modules.test.ts) cannot: a generated entry that no longer
 * resolves the self-host module, or a celld config that lost the HOSTED_GIT binding.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import * as TOML from '@iarna/toml';
import { afterAll, describe, expect, it } from 'vitest';

import type { WranglerToml } from '../../../../scripts/deploy/types';
import { ensureCelldBinary, resolveEsbuild } from '../../../../scripts/selfhost/celld-binary';
import { buildCelldConfig } from '../../../../scripts/selfhost/celld-config';
import {
  CELLD_MAIN,
  prepareCelldProject,
  writeCelldConfig,
} from '../../../../scripts/selfhost/celld-project';

const API_DIR = resolve(import.meta.dirname, '../..');
const scratch = mkdtempSync(join(tmpdir(), 'sam-celld-entry-'));

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe('generated celld project', () => {
  it.each([
    ['sealed (runtime secrets)', true],
    ['plain', false],
  ])(
    'bundles in %s mode with the HostedGitRepo binding',
    async (_mode, runtimeSecrets) => {
      const plan = buildCelldConfig(
        TOML.parse(readFileSync(join(API_DIR, 'wrangler.toml'), 'utf8')) as unknown as WranglerToml,
        { main: CELLD_MAIN, baseDomain: 'box.example.com' }
      );
      const projectDir = join(scratch, runtimeSecrets ? 'sealed' : 'plain');
      prepareCelldProject({ apiDir: API_DIR, projectDir, plan, runtimeSecrets });
      writeCelldConfig(projectDir, plan.config);

      const celld = await ensureCelldBinary(join(tmpdir(), 'sam-celld-bin'));
      const result = spawnSync(
        celld,
        ['deploy', projectDir, '--dry-run', '--bucket', 's3://dry-run-not-written'],
        {
          encoding: 'utf8',
          timeout: 300_000,
          env: { ...process.env, CELLD_ESBUILD: resolveEsbuild(API_DIR) },
        }
      );
      const output = `${result.stdout}${result.stderr}`;
      expect(result.status, output.slice(-4000)).toBe(0);
      expect(output).toContain('Bundled workspaces-api');
      expect(output).toMatch(/env\.HOSTED_GIT \(HostedGitRepo\)\s+Durable Object \(SQLite\)/);
      expect(output).toMatch(/env\.HOSTED_GIT_BACKEND \(Text\)/);
    },
    600_000
  );
});
