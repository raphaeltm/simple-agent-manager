/**
 * `scripts/deploy/configure-d1-read-replication.sh` — real CLI tests.
 *
 * This script is the deploy-pipeline owner of D1 `read_replication`, deliberately split out of
 * Pulumi so a live production D1 never carries a diff that a provider could resolve by
 * replacing the resource (`.claude/rules/31-migration-safety.md`). That makes its fail-closed
 * behaviour load-bearing: a silent no-op would leave every read crossing to the primary and
 * nothing would say so.
 *
 * `curl` is replaced with a scripted fake so the request/response contract is exercised without
 * touching Cloudflare. The workflow-shape assertions live in `deploy-reusable-workflow.test.ts`.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const REPO_ROOT = new URL('../..', import.meta.url);
const SCRIPT = 'scripts/deploy/configure-d1-read-replication.sh';
const PRIMARY_ID = '1cfaf5d4-8226-47d8-bf26-6ba727ce5718';
const OBSERVABILITY_ID = '8c2fa46c-3b89-428b-b235-d835b7914106';

interface RunResult {
  output: string;
  status: number;
  /** Each fake curl invocation's full argv, one per line. */
  requests: string[];
}

/**
 * `curl` fake. GET (no `-X`) returns a database document whose mode comes from
 * SAM_FAKE_CURRENT_MODE; PUT echoes back SAM_FAKE_APPLIED_MODE with SAM_FAKE_PUT_CODE, writing
 * the body to the `-o` target the script passes.
 */
const CURL_FAKE = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$SAM_FAKE_REQUEST_LOG"

OUT=""
IS_PUT=0
prev=""
for arg in "$@"; do
  if [ "$prev" = "-o" ]; then OUT="$arg"; fi
  if [ "$prev" = "-X" ] && [ "$arg" = "PUT" ]; then IS_PUT=1; fi
  prev="$arg"
done

if [ "$IS_PUT" = "1" ]; then
  BODY="{\\"success\\":true,\\"errors\\":[],\\"result\\":{\\"read_replication\\":{\\"mode\\":\\"\${SAM_FAKE_APPLIED_MODE}\\"}}}"
  if [ -n "$OUT" ]; then printf '%s' "$BODY" > "$OUT"; else printf '%s' "$BODY"; fi
  printf '%s' "\${SAM_FAKE_PUT_CODE}"
  exit 0
fi

if [ "\${SAM_FAKE_GET_OK}" != "true" ]; then
  printf '%s' '{"success":false,"errors":[{"code":10000,"message":"Authentication error"}]}'
  exit 0
fi
printf '%s' "{\\"success\\":true,\\"errors\\":[],\\"result\\":{\\"read_replication\\":{\\"mode\\":\\"\${SAM_FAKE_CURRENT_MODE}\\"}}}"
`;

function run(env: Record<string, string>): RunResult {
  const tmp = mkdtempSync(join(tmpdir(), 'sam-d1-replication-'));
  const curlPath = join(tmp, 'curl');
  const requestLog = join(tmp, 'requests.log');

  writeFileSync(curlPath, CURL_FAKE);
  chmodSync(curlPath, 0o755);
  writeFileSync(requestLog, '');

  const baseEnv: Record<string, string> = {
    CF_API_TOKEN: 'token-test',
    CF_ACCOUNT_ID: 'account-test',
    D1_DATABASE_IDS: `${PRIMARY_ID} ${OBSERVABILITY_ID}`,
    SAM_FAKE_GET_OK: 'true',
    SAM_FAKE_CURRENT_MODE: 'disabled',
    SAM_FAKE_APPLIED_MODE: 'auto',
    SAM_FAKE_PUT_CODE: '200',
    SAM_FAKE_REQUEST_LOG: requestLog,
  };

  try {
    let output: string;
    let status = 0;
    try {
      output = execFileSync('bash', [SCRIPT], {
        cwd: REPO_ROOT,
        env: { ...process.env, ...baseEnv, ...env, PATH: `${tmp}:${process.env.PATH ?? ''}` },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      const execError = error as { stdout?: string; stderr?: string; status?: number };
      output = `${execError.stdout ?? ''}${execError.stderr ?? ''}`;
      status = execError.status ?? 1;
    }

    const requests = readFileSync(requestLog, 'utf8').split('\n').filter(Boolean);
    return { output, status, requests };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

const putRequests = (result: RunResult) => result.requests.filter((line) => line.includes('-X PUT'));

describe('configure-d1-read-replication.sh', () => {
  it('enables auto replication on every supplied database', () => {
    const result = run({});

    expect(result.status).toBe(0);
    expect(result.output).toContain(`D1 ${PRIMARY_ID}: read replication 'disabled' -> 'auto'`);
    expect(result.output).toContain(`D1 ${OBSERVABILITY_ID}: read replication 'disabled' -> 'auto'`);
    expect(result.output).toContain("mode='auto', 2 of 2 database(s) changed");

    const puts = putRequests(result);
    expect(puts).toHaveLength(2);
    for (const put of puts) {
      expect(put).toContain('{"read_replication":{"mode":"auto"}}');
      // read_replication is the ONLY field this endpoint accepts, so the body must not carry
      // anything that could be interpreted as a rename or a jurisdiction change.
      expect(put).not.toMatch(/"name"|"jurisdiction"/);
    }
    expect(puts[0]).toContain(`/accounts/account-test/d1/database/${PRIMARY_ID}`);
    expect(puts[1]).toContain(`/accounts/account-test/d1/database/${OBSERVABILITY_ID}`);
  });

  it('is idempotent: a second run over already-auto databases writes nothing', () => {
    const result = run({ SAM_FAKE_CURRENT_MODE: 'auto' });

    expect(result.status).toBe(0);
    expect(result.output).toContain(`D1 ${PRIMARY_ID}: read replication already 'auto' — skipping`);
    expect(result.output).toContain("mode='auto', 0 of 2 database(s) changed");
    expect(putRequests(result)).toHaveLength(0);
    // Liveness beside the absence assertion: it really did talk to the API, twice.
    expect(result.requests).toHaveLength(2);
  });

  it('supports an explicit rollback to disabled', () => {
    const result = run({
      D1_READ_REPLICATION_MODE: 'disabled',
      SAM_FAKE_CURRENT_MODE: 'auto',
      SAM_FAKE_APPLIED_MODE: 'disabled',
    });

    expect(result.status).toBe(0);
    expect(putRequests(result)[0]).toContain('{"read_replication":{"mode":"disabled"}}');
  });

  it('fails closed when the database cannot be read', () => {
    const result = run({ SAM_FAKE_GET_OK: 'false' });

    expect(result.status).toBe(1);
    expect(result.output).toContain(`::error::Failed to read D1 database ${PRIMARY_ID}`);
    expect(result.output).toContain('Authentication error');
    expect(putRequests(result)).toHaveLength(0);
  });

  it('fails closed on a non-2xx PUT', () => {
    const result = run({ SAM_FAKE_PUT_CODE: '403' });

    expect(result.status).toBe(1);
    expect(result.output).toContain('::error::Failed to set D1 read replication');
    expect(result.output).toContain('HTTP 403');
  });

  it('fails closed when the API reports a mode other than the one requested', () => {
    // `.claude/rules/70`: trust the deployed value, not the request.
    const result = run({ SAM_FAKE_APPLIED_MODE: 'disabled' });

    expect(result.status).toBe(1);
    expect(result.output).toContain("reported read replication 'disabled' after requesting 'auto'");
  });

  it.each([
    ['an empty database list', { D1_DATABASE_IDS: '   ' }, 'resolved to no database IDs'],
    [
      'a non-UUID database id',
      { D1_DATABASE_IDS: 'not-a-uuid' },
      "'not-a-uuid' is not a database UUID",
    ],
    [
      'a partially-resolved list',
      { D1_DATABASE_IDS: `${PRIMARY_ID} ` },
      "read replication 'disabled' -> 'auto'",
    ],
  ])('handles %s', (_label, overrides, expected) => {
    const result = run(overrides as Record<string, string>);

    expect(result.output).toContain(expected);
  });

  it('rejects an unknown mode before contacting the API', () => {
    const result = run({ D1_READ_REPLICATION_MODE: 'first-unconstrained' });

    expect(result.status).toBe(1);
    expect(result.output).toContain("must be 'auto' or 'disabled'");
    expect(result.requests).toHaveLength(0);
  });

  it.each(['CF_API_TOKEN', 'CF_ACCOUNT_ID', 'D1_DATABASE_IDS'])(
    'refuses to run without %s',
    (name) => {
      const result = run({ [name]: '' });

      expect(result.status).toBe(1);
      expect(result.output).toContain(`missing required env vars: ${name}`);
      expect(result.requests).toHaveLength(0);
    }
  );
});
