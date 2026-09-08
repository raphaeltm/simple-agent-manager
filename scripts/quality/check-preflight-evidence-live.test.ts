/**
 * Vertical slice: prove that live PR state actually DRIVES the checker's verdict.
 *
 * The unit tests in `pr-evidence-source.test.ts` prove the resolver picks the right
 * source. They do not prove the checker still passes/fails correctly on that source
 * — and the existing subprocess tests never reach the `api` path at all, because
 * their event payloads omit `pull_request.number`, which short-circuits to fallback.
 *
 * So this drives the REAL CLI entry point against a REAL local HTTP server standing
 * in for the GitHub API (via GITHUB_API_URL), and asserts both directions:
 * good-live-body passes over a bad frozen body, and bad-live-body fails over a good
 * frozen body. Without the second case, the suite would prove only "we read the new
 * string", not "the gate still rejects" (.claude/rules/62, .claude/rules/35).
 */
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

const repoRoot = resolve(import.meta.dirname, '../..');
const checker = resolve(repoRoot, 'scripts/quality/check-preflight-evidence.ts');

const COMPLETE_EVIDENCE = `
<!-- AGENT_PREFLIGHT_START -->
## Agent Preflight (Required)

- [x] Preflight completed before code changes

### Classification

- [x] infra-change

### External References

Verified against the GitHub Actions workflow syntax documentation for job permissions.

### Codebase Impact Analysis

Touches scripts/quality only; no apps/ or packages/ runtime code is affected here.

### Documentation & Specs

N/A: internal CI plumbing with no user-facing surface or documented behaviour.

### Constitution & Risk Check

Principle XI checked; the timeout is env-configurable with a DEFAULT constant.
<!-- AGENT_PREFLIGHT_END -->
`;

const MISSING_EVIDENCE = '## Summary\n\nNo preflight block at all.';

let server: Server;
let apiUrl: string;
/** Body the fake API returns for the PR. Mutated per test. */
let liveBody = '';

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url?.match(/^\/repos\/[^/]+\/[^/]+\/pulls\/\d+$/)) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ body: liveBody, html_url: 'https://example/pr/1', labels: [] }));
      return;
    }
    res.writeHead(404);
    res.end('{}');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const address = server.address();
  if (typeof address === 'string' || address === null) throw new Error('no port');
  apiUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

async function runAgainstLive(frozenBody: string): Promise<{ output: string; status: number }> {
  const tmpRoot = join(repoRoot, '.tmp');
  mkdirSync(tmpRoot, { recursive: true });
  const dir = mkdtempSync(join(tmpRoot, 'sam-preflight-live-'));
  const eventPath = join(dir, 'event.json');
  writeFileSync(
    eventPath,
    JSON.stringify({
      pull_request: {
        number: 4242,
        body: frozenBody,
        html_url: 'https://github.com/example/repo/pull/4242',
        labels: [],
      },
    })
  );

  const options = {
    cwd: repoRoot,
    env: {
      ...process.env,
      GITHUB_EVENT_NAME: 'pull_request',
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_TOKEN: 'test-token',
      GITHUB_REPOSITORY: 'example/repo',
      GITHUB_API_URL: apiUrl,
    },
  };

  try {
    const { stdout, stderr } = await execFileAsync('pnpm', ['exec', 'tsx', checker], options);
    return { output: `${stdout}${stderr}`, status: 0 };
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; code?: number };
    return { output: `${e.stdout ?? ''}${e.stderr ?? ''}`, status: e.code ?? 1 };
  }
}

describe('preflight evidence is decided by live PR state', () => {
  it('PASSES on a fixed live body even though the frozen payload is missing evidence', async () => {
    // The incident: body corrected after the run was triggered.
    liveBody = COMPLETE_EVIDENCE;
    const result = await runAgainstLive(MISSING_EVIDENCE);

    expect(result.output).toContain('from: api');
    expect(result.status).toBe(0);
  });

  it('STILL FAILS when the live body is missing evidence, even if the frozen one had it', async () => {
    // The discriminating control. Without this the suite would pass equally well
    // if the checker had stopped rejecting anything at all.
    liveBody = MISSING_EVIDENCE;
    const result = await runAgainstLive(COMPLETE_EVIDENCE);

    expect(result.output).toContain('from: api');
    expect(result.output).toMatch(/Missing or malformed Agent Preflight block/);
    expect(result.status).toBe(1);
  });

  it('exits non-zero on a structurally invalid event payload (async fail-closed)', async () => {
    // Exercises the outer main().catch wiring through the real entry point:
    // an async rejection must not exit 0 and silently pass a merge gate.
    const tmpRoot = join(repoRoot, '.tmp');
    mkdirSync(tmpRoot, { recursive: true });
    const dir = mkdtempSync(join(tmpRoot, 'sam-preflight-bad-'));
    const eventPath = join(dir, 'event.json');
    writeFileSync(eventPath, JSON.stringify({ not_a_pull_request: true }));

    let status = 0;
    let output = '';
    try {
      const { stdout, stderr } = await execFileAsync('pnpm', ['exec', 'tsx', checker], {
        cwd: repoRoot,
        env: {
          ...process.env,
          GITHUB_EVENT_NAME: 'pull_request',
          GITHUB_EVENT_PATH: eventPath,
        },
      });
      output = `${stdout}${stderr}`;
    } catch (error) {
      const e = error as { stdout?: string; stderr?: string; code?: number };
      output = `${e.stdout ?? ''}${e.stderr ?? ''}`;
      status = e.code ?? 1;
    }

    expect(status).toBe(1);
    expect(output).toMatch(/must include pull_request/);
  });
});
