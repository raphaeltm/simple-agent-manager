// Fixed adapter: only the trusted source checkout chooses executable hooks.
import { writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
export function builderEngineConfig(supplied, approvedCommit) {
  const { sourceCommit, accountId, zoneId, zoneName, baseDomain, environment, prefix, ownerEmail } =
    supplied;
  if (sourceCommit !== approvedCommit) throw new Error('Source approval mismatch');
  return {
    schemaVersion: 1,
    ownerEmail,
    sourceCommit,
    accountId,
    zoneId,
    zoneName,
    baseDomain,
    environment,
    prefix,
    codexBuild: {
      executable: 'bash',
      args: ['scripts/deploy/installer-builder-bootstrap-codex.sh'],
    },
    codexPublish: {
      executable: 'bash',
      args: [
        'scripts/deploy/publish-codex-runtime-artifact.sh',
        'apps/api/container-artifacts/codex-runtime-linux-amd64.tar.gz',
      ],
    },
  };
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const config = builderEngineConfig(
    JSON.parse(process.env.SAM_ENGINE_CONFIG ?? '{}'),
    process.env.SAM_SOURCE_COMMIT
  );
  const configPath = '/sam/job/engine-config.json';
  writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
  const child = spawn(
    'pnpm',
    [
      'exec',
      'tsx',
      'scripts/deploy/installer-engine-cli.ts',
      '--config',
      configPath,
      '--state',
      '/sam/job/checkpoint.json',
    ],
    { stdio: 'ignore', env: process.env }
  );
  child.once('error', () => {
    process.exitCode = 1;
  });
  child.once('close', (code) => {
    process.exitCode = code === 0 ? 0 : 1;
  });
}
