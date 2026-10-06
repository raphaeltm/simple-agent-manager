/**
 * Architectural enumeration test for `.claude/rules/61-guards-must-cover-every-runtime.md`.
 *
 * The bug this PR fixes was NOT a logic error — it was a new provisioning
 * substrate (the cf-container "Instant" runtime) being added without the
 * checkout-branch guard the VM runtime already had. Every unit test stayed
 * green while 35 production tasks failed, because nothing asserted the
 * precondition at the *operation* level.
 *
 * This test closes that hole: every file that provisions a workspace on a node
 * must either run the guard or appear on an explicit allowlist with a written
 * reason. Adding a third runtime without the guard turns CI red.
 *
 * It is intentionally a structural test over the import graph, not a
 * source-contract test of behaviour (rule 02) — the behaviour is covered by
 * workspace-branch.test.ts, instant-session-branch-guard.test.ts, and
 * instant-session-branch-vertical-slice.test.ts.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { collectSourceFiles, SRC_ROOT } from '../../helpers/source-tree';

/** The call that hands a checkout branch to a workspace runtime. */
const PROVISIONING_CALL = 'createWorkspaceOnNode(';

/** Either the shared guard or the DO wrapper that delegates to it. */
const GUARD_SYMBOLS = ['ensureWorkspaceBranchOnRemote', 'ensureBranchExistsOnRemote'];

/**
 * Provisioning paths that legitimately do not run the guard. Each entry must
 * say WHY — "it seemed fine" is how the Instant runtime shipped broken.
 */
const ALLOWLIST: Record<string, string> = {
  'services/node-agent.ts':
    'Defines createWorkspaceOnNode itself; it is the transport, not a provisioning entry point.',
  'routes/workspaces/_helpers.ts':
    'scheduleWorkspaceCreateOnNode is a VM-only transport helper. Its only caller (routes/workspaces/crud.ts) ' +
    'takes the branch from the user-selected existing-branch list or the project default, validates its ' +
    'characters, and provisions a VM whose bootstrap.go clones baseBranch and `git checkout -b`s the target.',
  'routes/node-lifecycle.ts':
    're-creates an ALREADY EXISTING workspace row on node restart using workspace.branch, which was ensured ' +
    'when that workspace was first created. It also explicitly excludes cf-container workspaces.',
  'durable-objects/trial-orchestrator/steps.ts':
    'Trials always provision on the repository default branch (probed from GitHub, TRIAL_FALLBACK_BRANCH ' +
    'otherwise), so the guard would short-circuit as `skipped` anyway.',
};

function relativeToSrc(file: string): string {
  return path.relative(SRC_ROOT, file).split(path.sep).join('/');
}

describe('workspace provisioning paths all run the checkout-branch guard', () => {
  const provisioningFiles = collectSourceFiles(SRC_ROOT)
    .filter((file) => readFileSync(file, 'utf8').includes(PROVISIONING_CALL))
    .map(relativeToSrc)
    .sort();

  it('finds the known provisioning entry points (guards against a silent no-op scan)', () => {
    // If this fails, the scan is broken or the call was renamed — fix the scan,
    // do not delete the test. A green suite over zero files proves nothing
    // (rule 02: "a green test count is not a green suite").
    expect(provisioningFiles).toContain('services/instant-session.ts');
    expect(provisioningFiles).toContain('durable-objects/task-runner/workspace-steps.ts');
    expect(provisioningFiles.length).toBeGreaterThanOrEqual(4);
  });

  it('every provisioning path runs the guard or is explicitly allowlisted', () => {
    const unguarded = provisioningFiles.filter((relative) => {
      if (relative in ALLOWLIST) return false;
      const source = readFileSync(path.join(SRC_ROOT, relative), 'utf8');
      return !GUARD_SYMBOLS.some((symbol) => source.includes(symbol));
    });

    expect(
      unguarded,
      `These files provision a workspace without ensuring the checkout branch exists on the remote. ` +
        `A never-pushed branch makes the standalone clone fail with exit 128 and burns a container. ` +
        `Call ensureWorkspaceBranchOnRemote(), or add an entry to ALLOWLIST in this file explaining ` +
        `why the guard does not apply. See .claude/rules/61-guards-must-cover-every-runtime.md.`
    ).toEqual([]);
  });

  it('the allowlist has no stale entries', () => {
    const stale = Object.keys(ALLOWLIST).filter(
      (relative) => !provisioningFiles.includes(relative)
    );

    expect(
      stale,
      'These allowlist entries no longer provision a workspace — delete them so the allowlist keeps ' +
        'documenting real decisions rather than accumulating dead exemptions.'
    ).toEqual([]);
  });

  it('the guard itself is reachable from both runtimes', () => {
    const instant = readFileSync(path.join(SRC_ROOT, 'services/instant-session.ts'), 'utf8');
    const vmDelegate = readFileSync(
      path.join(SRC_ROOT, 'durable-objects/task-runner/workspace-branch.ts'),
      'utf8'
    );

    expect(instant).toContain('ensureWorkspaceBranchOnRemote');
    expect(vmDelegate).toContain('ensureWorkspaceBranchOnRemote');
  });
});
