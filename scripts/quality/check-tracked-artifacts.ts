import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const DEFAULT_BLOCKED_ARTIFACTS = ['packages/vm-agent/vm-agent'];

export interface ArtifactFinding {
  path: string;
  reason: string;
}

export interface ArtifactCheckResult {
  findings: ArtifactFinding[];
}

export function checkTrackedArtifacts(
  root = resolve(import.meta.dirname, '../..'),
  blockedArtifacts = DEFAULT_BLOCKED_ARTIFACTS
): ArtifactCheckResult {
  const trackedFiles = new Set(
    execFileSync('git', ['ls-files', ...blockedArtifacts], {
      cwd: root,
      encoding: 'utf8',
    })
      .split('\n')
      .filter(Boolean)
  );

  const findings: ArtifactFinding[] = [];

  for (const artifact of blockedArtifacts) {
    if (trackedFiles.has(artifact)) {
      findings.push({
        path: artifact,
        reason: 'tracked by git',
      });
      continue;
    }

    const absolutePath = join(root, artifact);
    if (existsSync(absolutePath)) {
      const stats = statSync(absolutePath);
      if (stats.isFile()) {
        findings.push({
          path: artifact,
          reason: 'present in working tree',
        });
      }
    }
  }

  return { findings };
}

function main(): void {
  const result = checkTrackedArtifacts();

  if (result.findings.length === 0) {
    console.log('Tracked artifact guard passed');
    return;
  }

  console.error(
    'Tracked artifact guard failed: stale build artifacts must not be committed or left at blocked paths.'
  );
  for (const finding of result.findings) {
    console.error(`- ${finding.path}: ${finding.reason}`);
  }
  process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
