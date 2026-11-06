import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';

const boundary = vi.hoisted(() => ({ run: vi.fn(async () => ({})) }));
vi.mock('./installer-engine.js', async (original) => ({
  ...(await original<typeof import('./installer-engine.js')>()),
  runInstallerEngine: boundary.run,
}));
import { main } from './installer-engine-ci-cli';
const directories: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  boundary.run.mockClear();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
describe('actual CI CLI startup', () => {
  it('accepts the workflow whitelist with missing optional secrets and transfers required engine credentials', async () => {
    const workflow = parse(readFileSync('.github/workflows/deploy-reusable.yml', 'utf8'));
    const template: string = workflow.jobs.deploy.steps.find(
      (step: { id?: string }) => step.id === 'shared_engine'
    ).env.SAM_CI_SECRETS_JSON;
    const supplied: Record<string, string> = {
      CF_ACCOUNT_ID: 'a'.repeat(32),
      CF_ZONE_ID: 'b'.repeat(32),
      CF_API_TOKEN: 'private-deployment',
      R2_ACCESS_KEY_ID: 'private-access',
      R2_SECRET_ACCESS_KEY: 'private-r2',
      PULUMI_CONFIG_PASSPHRASE: 'private-passphrase',
      GH_APP_PRIVATE_KEY: 'quote"\nprivate-key',
    };
    const serialized = template.replace(
      /\$\{\{ toJSON\(secrets\.([A-Z_0-9]+) \|\| ''\) \}\}/g,
      (_match, name: string) => JSON.stringify(supplied[name] || '')
    );
    const privateInput = JSON.parse(serialized);
    expect(privateInput.CREDENTIAL_ENCRYPTION_KEY).toBe('');
    expect(privateInput.GH_APP_PRIVATE_KEY).toBe(supplied.GH_APP_PRIVATE_KEY);
    vi.stubEnv('SAM_CI_SECRETS_JSON', serialized);
    vi.stubEnv('GITHUB_STEP_SUMMARY', '');
    vi.stubEnv('GITHUB_OUTPUT', '');
    const directory = mkdtempSync(join(tmpdir(), 'installer-ci-cli-'));
    directories.push(directory);
    const path = join(directory, 'input.json');
    writeFileSync(
      path,
      JSON.stringify({
        sourceCommit: 'c'.repeat(40),
        environment: 'staging',
        variables: { BASE_DOMAIN: 'example.com', RESOURCE_PREFIX: 'sam' },
      })
    );
    await main([path, join(directory, 'state.json')]);
    expect(boundary.run).toHaveBeenCalledOnce();
    const [config, options] = boundary.run.mock.calls[0] as unknown as [
      { stateBucket: string },
      { environment: Record<string, string> },
    ];
    expect(config.stateBucket).toBe('sam-pulumi-state');
    expect(options.environment).toMatchObject({
      CF_API_TOKEN: supplied.CF_API_TOKEN,
      R2_ACCESS_KEY_ID: supplied.R2_ACCESS_KEY_ID,
      R2_SECRET_ACCESS_KEY: supplied.R2_SECRET_ACCESS_KEY,
      PULUMI_CONFIG_PASSPHRASE: supplied.PULUMI_CONFIG_PASSPHRASE,
      GH_APP_PRIVATE_KEY: supplied.GH_APP_PRIVATE_KEY,
    });
    expect(options.environment).not.toHaveProperty('SAM_CI_SECRETS_JSON');
  });
  it('reports only a safe startup stage when private JSON is invalid', () => {
    const directory = mkdtempSync(join(tmpdir(), 'installer-ci-invalid-'));
    directories.push(directory);
    const path = join(directory, 'input.json');
    writeFileSync(path, '{}');
    const result = spawnSync(
      process.execPath,
      [
        join(process.cwd(), 'node_modules/tsx/dist/cli.mjs'),
        join(process.cwd(), 'scripts/deploy/installer-engine-ci-cli.ts'),
        path,
        join(directory, 'state.json'),
      ],
      { encoding: 'utf8', env: { ...process.env, SAM_CI_SECRETS_JSON: 'private-invalid-json' } }
    );
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stderr)).toEqual({
      status: 'failed',
      stage: 'private-input-json',
      code: 'CI_DEPLOYMENT_STOPPED',
    });
    expect(result.stdout + result.stderr).not.toContain('private-invalid-json');
  });
});
