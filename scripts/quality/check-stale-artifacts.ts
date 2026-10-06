/**
 * Stale Artifact Quality Check
 *
 * Prevents source-control drift from checked-in build artifacts that are built
 * fresh by deployment workflows.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../..');
const GIT_BIN = '/usr/bin/git';

const STALE_ARTIFACTS = [
  {
    path: 'packages/vm-agent/vm-agent',
    reason:
      'VM-agent deployment artifacts are built from source into packages/vm-agent/bin and apps/api/container-artifacts.',
  },
];

function isTracked(path: string): boolean {
  try {
    execFileSync(GIT_BIN, ['ls-files', '--error-unmatch', path], { cwd: ROOT, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const violations = STALE_ARTIFACTS.filter((artifact) => {
  return isTracked(artifact.path) || existsSync(resolve(ROOT, artifact.path));
});

if (violations.length > 0) {
  console.error(
    'Stale artifact check FAILED. Remove these generated artifacts from the repository:'
  );
  for (const artifact of violations) {
    console.error(`  ${artifact.path} — ${artifact.reason}`);
  }
  process.exit(1);
}

console.log('Stale artifact check passed.');
