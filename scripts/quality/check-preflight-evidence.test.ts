import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, type ExecFileSyncOptions } from 'node:child_process';

import { describe, expect, it } from 'vitest';

const repoRoot = resolve(import.meta.dirname, '../..');
const checker = resolve(repoRoot, 'scripts/quality/check-preflight-evidence.ts');

function writePayload(body: string): string {
  const tmpRoot = join(repoRoot, '.tmp');
  mkdirSync(tmpRoot, { recursive: true });
  const dir = mkdtempSync(join(tmpRoot, 'sam-preflight-'));
  const eventPath = join(dir, 'event.json');
  writeFileSync(
    eventPath,
    JSON.stringify({
      pull_request: {
        body,
        html_url: 'https://github.com/example/repo/pull/123',
      },
    })
  );
  return eventPath;
}

function runChecker(body: string): { output: string; status: number } {
  const env = {
    ...process.env,
    GITHUB_EVENT_NAME: 'pull_request',
    GITHUB_EVENT_PATH: writePayload(body),
  };
  const options: ExecFileSyncOptions = {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  };

  try {
    const output = execFileSync('pnpm', ['exec', 'tsx', checker], options) as string;
    return { output, status: 0 };
  } catch (error) {
    const execError = error as {
      stderr?: Buffer | string;
      stdout?: Buffer | string;
      status?: number;
    };
    return {
      output: `${execError.stdout ?? ''}${execError.stderr ?? ''}`,
      status: execError.status ?? 1,
    };
  }
}

function baseBody(classificationLines: string): string {
  return `## Summary

Test PR.

<!-- AGENT_PREFLIGHT_START -->

## Agent Preflight (Required)

- [x] Preflight completed before code changes

### Classification

${classificationLines}

### External References

N/A: no external API changes.

### Codebase Impact Analysis

Changes apps/web and scripts/quality paths for UI review evidence.

### Documentation & Specs

N/A: internal repository quality gate only.

### Constitution & Risk Check

Checked quality gates and review evidence durability.

<!-- AGENT_PREFLIGHT_END -->`;
}

describe('check-preflight-evidence', () => {
  it('fails ui-change PRs without UI screenshot evidence', () => {
    const result = runChecker(baseBody('- [x] ui-change'));

    expect(result.status).not.toBe(0);
    expect(result.output).toContain('UI Screenshot Evidence');
  });

  it('passes ui-change PRs with desktop/mobile Playwright screenshots and review attestation', () => {
    const body = `${baseBody('- [x] ui-change')}

### UI Screenshot Evidence

- PR screenshot comment: https://github.com/example/repo/pull/123#issuecomment-1
- Desktop screenshots: ![desktop](https://example.com/desktop.png)
- Mobile screenshots: ![mobile](https://example.com/mobile.png)
- Mock/stress data used: Playwright mock data covered long text, many items, empty, error, and special characters to push the limits of the UI.
- Screenshot quality review: Reviewed the screenshots for quality, overflow, clipping, readability, and responsive behavior; no visual issues found.`;

    const result = runChecker(body);

    expect(result.output).toContain('Preflight evidence check passed.');
    expect(result.status).toBe(0);
  });

  it('passes ui-change PRs whose screenshots are referenced by a PR comment link', () => {
    const body = `${baseBody('- [x] ui-change')}

### UI Screenshot Evidence

- PR screenshot comment: https://github.com/example/repo/pull/123#issuecomment-42
- Desktop screenshots: https://github.com/example/repo/pull/123#issuecomment-42
- Mobile screenshots: https://github.com/example/repo/pull/123#issuecomment-42
- Mock/stress data used: Playwright mock data covered long text, many items, empty, error, and special characters to push the limits of the UI.
- Screenshot quality review: Reviewed the inbound comment screenshots for quality, overflow, clipping, readability, and responsive behavior; no visual issues found.`;

    const result = runChecker(body);

    expect(result.output).toContain('Preflight evidence check passed.');
    expect(result.status).toBe(0);
  });
});
