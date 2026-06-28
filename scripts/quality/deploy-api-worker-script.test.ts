import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const scriptPath = resolve(import.meta.dirname, '../deploy/deploy-api-worker.sh');
const tempDirs: string[] = [];

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
  tempDir: string;
}

function writeExecutable(path: string, content: string): void {
  writeFileSync(path, content, 'utf8');
  chmodSync(path, 0o755);
}

function runScript(scenario: string, curlHttpCode = '404'): RunResult {
  const tempDir = mkdtempSync(join(tmpdir(), 'sam-api-worker-deploy-'));
  tempDirs.push(tempDir);

  const binDir = join(tempDir, 'bin');
  const callsFile = join(tempDir, 'calls.log');
  const githubEnvFile = join(tempDir, 'github-env');
  const deployCountFile = join(tempDir, 'deploy-count');
  const syncBackendFile = join(tempDir, 'sync-backend');

  mkdirSync(binDir);
  writeFileSync(callsFile, '', 'utf8');
  writeFileSync(deployCountFile, '0', 'utf8');
  writeFileSync(githubEnvFile, '', 'utf8');
  writeExecutable(
    `${binDir}/pnpm`,
    `#!/usr/bin/env bash
set -euo pipefail
echo "$*" >> "${callsFile}"
if [[ "$*" == *"wrangler deploy"* ]]; then
  count=$(cat "${deployCountFile}")
  count=$((count + 1))
  echo "$count" > "${deployCountFile}"
  case "${scenario}" in
    success)
      echo "Deployment complete"
      exit 0
      ;;
    non_inherited_success)
      echo "These bindings are not inherited by environments"
      exit 0
      ;;
    non_10097_failure)
      echo "Wrangler failed for another reason"
      exit 42
      ;;
    fresh_10097_retry)
      if [ "$count" -eq 1 ]; then
        echo 'In order to use Durable Objects with a free plan, you must create a namespace using a new_sqlite_classes migration. [code: 10097]'
        exit 1
      fi
      echo "Deployment complete after retry"
      exit 0
      ;;
    existing_10097)
      echo 'In order to use Durable Objects with a free plan, you must create a namespace using a new_sqlite_classes migration. [code: 10097]'
      exit 1
      ;;
    retry_failure)
      if [ "$count" -eq 1 ]; then
        echo 'In order to use Durable Objects with a free plan, you must create a namespace using a new_sqlite_classes migration. [code: 10097]'
        exit 1
      fi
      echo "Retry failed"
      exit 43
      ;;
  esac
fi

if [[ "$*" == "tsx scripts/deploy/sync-wrangler-config.ts" ]]; then
  echo "\${SAM_DO_MIGRATION_BACKEND:-}" > "${syncBackendFile}"
  exit 0
fi

echo "Unexpected pnpm command: $*" >&2
exit 99
`
  );

  writeExecutable(
    `${binDir}/curl`,
    `#!/usr/bin/env bash
set -euo pipefail
out_file=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o)
      out_file="$2"
      shift 2
      ;;
    -w)
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done
if [ -n "$out_file" ]; then
  echo '{"success":true}' > "$out_file"
fi
printf '%s' "${curlHttpCode}"
`
  );

  const result = spawnSync('bash', [scriptPath], {
    cwd: resolve(import.meta.dirname, '../..'),
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      DEPLOY_ENV: 'production',
      CF_ACCOUNT_ID: 'account-id',
      CF_API_TOKEN: 'token',
      API_WORKER_NAME: 'prefix-api-prod',
      GITHUB_ENV: githubEnvFile,
    },
  });

  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    tempDir,
  };
}

function readTempFile(result: RunResult, fileName: string): string {
  return readFileSync(join(result.tempDir, fileName), 'utf8');
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('deploy-api-worker.sh', () => {
  it('passes through successful Wrangler deploys', () => {
    const result = runScript('success');

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Deployment complete');
    expect(readTempFile(result, 'calls.log')).not.toContain('sync-wrangler-config');
  });

  it('fails successful deploy output that reports non-inherited bindings', () => {
    const result = runScript('non_inherited_success');

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('Wrangler detected non-inherited bindings');
  });

  it('passes through non-10097 Wrangler failures', () => {
    const result = runScript('non_10097_failure');

    expect(result.status).toBe(42);
    expect(result.stdout).toContain('Wrangler failed for another reason');
    expect(readTempFile(result, 'calls.log')).not.toContain('sync-wrangler-config');
  });

  it('re-syncs with SQLite migrations and retries for fresh Free-plan deploys', () => {
    const result = runScript('fresh_10097_retry', '404');

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Treating this as a fresh deploy');
    expect(result.stdout).toContain('Deployment complete after retry');
    expect(readTempFile(result, 'sync-backend').trim()).toBe('sqlite');
    expect(readTempFile(result, 'github-env')).toContain('SAM_DO_MIGRATION_BACKEND=sqlite');
    expect(readTempFile(result, 'calls.log').match(/wrangler deploy/g)).toHaveLength(2);
  });

  it('does not retry 10097 for existing API Workers', () => {
    const result = runScript('existing_10097', '200');

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('already exists');
    expect(result.stdout).toContain('cannot be converted to SQLite in place');
    expect(readTempFile(result, 'calls.log')).not.toContain('sync-wrangler-config');
    expect(readTempFile(result, 'calls.log').match(/wrangler deploy/g)).toHaveLength(1);
  });

  it('returns the retry deploy status when the SQLite retry fails', () => {
    const result = runScript('retry_failure', '404');

    expect(result.status).toBe(43);
    expect(result.stdout).toContain('Retry failed');
    expect(readTempFile(result, 'sync-backend').trim()).toBe('sqlite');
  });
});
