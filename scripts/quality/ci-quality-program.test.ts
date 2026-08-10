import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const ci = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
const parsedRootManifest: unknown = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8')
);
if (
  typeof parsedRootManifest !== 'object' ||
  parsedRootManifest === null ||
  !('scripts' in parsedRootManifest) ||
  typeof parsedRootManifest.scripts !== 'object' ||
  parsedRootManifest.scripts === null
) {
  throw new Error('Root package manifest scripts are invalid.');
}
const rootScripts = Object.fromEntries(
  Object.entries(parsedRootManifest.scripts).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string'
  )
);

function jobBlock(workflow: string, jobName: string): string {
  const match = workflow.match(
    new RegExp(String.raw`\n  ${jobName}:\n[\s\S]*?(?=\n  [a-zA-Z0-9_-]+:\n|\n*$)`)
  );
  expect(match?.[0], `missing ${jobName} job`).toBeDefined();
  if (!match) throw new Error(`Missing ${jobName} job.`);
  return match[0];
}

describe('deterministic quality-program CI wiring', () => {
  it('uses the same check:fast leaf commands in the blocking lint job', () => {
    expect(rootScripts['check:fast']).toBe(
      'pnpm format:check && pnpm lint:oxlint && pnpm lint && pnpm quality:type-boundaries'
    );
    const lint = jobBlock(ci, 'lint');
    const commands = [
      'pnpm format:check',
      'pnpm lint:oxlint',
      'pnpm lint',
      'pnpm quality:type-boundaries',
    ];
    let previous = -1;
    for (const command of commands) {
      const current = lint.indexOf(`run: ${command}\n`);
      expect(current, `${command} must be an executable lint-job leaf`).toBeGreaterThan(previous);
      previous = current;
    }
    expect(lint).toContain('run: pnpm --filter @simple-agent-manager/eslint-plugin-sam test');
    expect(lint).toContain('pnpm lint:oxlint:sam-shadow');
    expect(lint).toContain('continue-on-error: true');
  });

  it('blocks current-tree/PR-range secrets and changed Go modules through privacy-safe wrappers', () => {
    const secretScan = jobBlock(ci, 'secret-scan');
    expect(secretScan).toContain('fetch-depth: 0');
    expect(secretScan).toContain('pnpm quality:gitleaks:current');
    expect(secretScan).toContain('pnpm quality:gitleaks:pr');
    expect(secretScan).not.toContain('upload-artifact');

    const govulncheck = jobBlock(ci, 'go-vulnerability-diff');
    expect(govulncheck).toContain('needs: [changes]');
    expect(govulncheck).toContain("needs.changes.outputs.go-modules == 'true'");
    expect(govulncheck).toContain('pnpm quality:govulncheck-diff');
  });

  it('enforces dependency evidence and keeps semantic findings in shadow mode', () => {
    const quality = jobBlock(ci, 'code-quality');
    expect(quality).toContain('fetch-depth: 0');
    expect(quality).toContain('pnpm quality:direct-dependency-evidence');
    expect(quality).toContain('pnpm quality:runtime-boundary-semantics');
  });
});
