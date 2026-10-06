import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
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

function surfaceBlock(
  name: string,
  options: { desktop?: string; mobile?: string; stress?: string; qualityReview?: string } = {}
): string {
  const desktop = options.desktop ?? `![${name}-desktop](https://example.com/${name}-desktop.png)`;
  const mobile = options.mobile ?? `![${name}-mobile](https://example.com/${name}-mobile.png)`;
  const stress =
    options.stress ??
    'Playwright mock data covered long text, many items, empty, error, and special characters to push the limits of this surface.';
  const qualityReview =
    options.qualityReview ??
    'Reviewed the screenshots for quality, overflow, clipping, readability, and responsive behavior; no visual issues found.';

  return `#### Surface: ${name}

- Desktop evidence: ${desktop}
- Mobile evidence: ${mobile}
- Mock/stress data used: ${stress}
- Screenshot quality review: ${qualityReview}`;
}

describe('check-preflight-evidence', () => {
  it('fails ui-change PRs without UI screenshot evidence', () => {
    const result = runChecker(baseBody('- [x] ui-change'));

    expect(result.status).not.toBe(0);
    expect(result.output).toContain('UI Screenshot Evidence');
  });

  it('passes ui-change PRs with per-surface desktop/mobile Playwright screenshots and review attestation', () => {
    const body = `${baseBody('- [x] ui-change')}

### UI Screenshot Evidence

${surfaceBlock('Capacity pool scopes panel')}

${surfaceBlock('Project settings infrastructure tab')}`;

    const result = runChecker(body);

    expect(result.output).toContain('Preflight evidence check passed.');
    expect(result.status).toBe(0);
  });

  it('passes ui-change PRs whose per-surface screenshots are referenced by PR comment links', () => {
    const body = `${baseBody('- [x] ui-change')}

### UI Screenshot Evidence

${surfaceBlock('Capacity pool scopes panel', {
  desktop: 'https://github.com/example/repo/pull/123#issuecomment-42',
  mobile: 'https://github.com/example/repo/pull/123#issuecomment-42',
})}

${surfaceBlock('Project settings infrastructure tab', {
  desktop: 'https://github.com/example/repo/pull/123#issuecomment-43',
  mobile: 'https://github.com/example/repo/pull/123#issuecomment-43',
})}`;

    const result = runChecker(body);

    expect(result.output).toContain('Preflight evidence check passed.');
    expect(result.status).toBe(0);
  });

  it('fails ui-change PRs when one surface is missing mobile or desktop evidence', () => {
    const body = `${baseBody('- [x] ui-change')}

### UI Screenshot Evidence

${surfaceBlock('Capacity pool scopes panel', { mobile: 'no screenshot posted on this surface' })}

${surfaceBlock('Project settings infrastructure tab')}`;

    const result = runChecker(body);

    expect(result.status).not.toBe(0);
    expect(result.output).toContain('missing mobile screenshot evidence');
    expect(result.output).toContain('Capacity pool scopes panel');
  });

  it('fails ui-change PRs with global-only screenshot evidence that does not enumerate surfaces', () => {
    const body = `${baseBody('- [x] ui-change')}

### UI Screenshot Evidence

- PR screenshot comment: https://github.com/example/repo/pull/123#issuecomment-1
- Desktop screenshots: ![desktop](https://example.com/desktop.png)
- Mobile screenshots: ![mobile](https://example.com/mobile.png)
- Mock/stress data used: Playwright mock data covered long text, many items, empty, error, and special characters to push the limits of the UI.
- Screenshot quality review: Reviewed the screenshots for quality, overflow, clipping, readability, and responsive behavior; no visual issues found.`;

    const result = runChecker(body);

    expect(result.status).not.toBe(0);
    expect(result.output).toContain('enumerate every changed UI surface');
  });

  it('preserves existing preflight behavior for non-UI PRs', () => {
    const result = runChecker(baseBody('- [x] business-logic-change'));

    expect(result.output).toContain('Preflight evidence check passed.');
    expect(result.status).toBe(0);
  });
});
