import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const patchedGoToolchain = 'go1.26.6';
const goVersion = patchedGoToolchain.replace(/^go/, '');

function readRepoFile(path: string): string {
  return readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
}

function expectGoModDirectives(path: string, languageDirective: string): void {
  const content = readRepoFile(path);

  expect(content).toContain(`go ${languageDirective}\n`);
  expect(content).toContain(`toolchain ${patchedGoToolchain}\n`);
}

function expectWorkflowUsesPinnedGo(path: string): void {
  const content = readRepoFile(path);

  expect(content).toContain(`GO_VERSION: '${goVersion}'`);
  expect(content).not.toMatch(/go-version:\s*['"]?1\.2[45](?:['"])?/);
  expect(content).toContain(`go-version: \${{ env.GO_VERSION }}`);
  expect(content).toContain(
    `go version | grep -E '^go version ${patchedGoToolchain.replaceAll('.', '\\.')} '`
  );
}

describe('Go toolchain floor', () => {
  it('pins patched toolchains without changing source language directives', () => {
    expectGoModDirectives('packages/vm-agent/go.mod', '1.25.0');
    expectGoModDirectives('packages/cli/go.mod', '1.24.0');
    expectGoModDirectives('scripts/quality/govulncheck-tool/go.mod', '1.25.0');
  });

  it('uses and asserts the same patched Go release in CI and release workflows', () => {
    expectWorkflowUsesPinnedGo('.github/workflows/ci.yml');
    expectWorkflowUsesPinnedGo('.github/workflows/e2e-smoke.yml');
    expectWorkflowUsesPinnedGo('.github/workflows/deploy-reusable.yml');
  });

  it('keeps developer tooling and public guidance aligned with the patched floor', () => {
    expect(readRepoFile('.devcontainer/devcontainer.json')).toContain(`"version": "${goVersion}"`);

    expect(readRepoFile('apps/www/src/content/docs/docs/guides/local-development.md')).toContain(
      `Go ${goVersion}+ is needed if you're working on the VM Agent (\`packages/vm-agent/\`) or CLI (\`packages/cli/\`).`
    );
    expect(readRepoFile('CLAUDE.md')).toContain(`Go ${goVersion}+ (VM Agent + CLI toolchain)`);
    expect(readRepoFile('AGENTS.md')).toContain(`Go ${goVersion}+ (VM Agent + CLI toolchain)`);
  });
});
