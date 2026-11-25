/**
 * Operator commands must not depend on the shell's umask (idea 01M89H1MQHJH432BFT2N43GHJJ).
 *
 * On 2026-11-25 an upgrade run under `umask 077` checked out 111 tracked files as 0600. The key
 * agent image copies `deploy/selfhost/key-agent/*.ts` and runs as the non-root
 * `SAM_KEY_AGENT_UID`, so it crash-looped with EACCES, and the automatic rollback checked the old
 * ref out under the same umask and failed the same way.
 *
 * Two guards, each sufficient for tracked files on its own:
 * - `useOperatorUmask()` at every operator entry point, so git, pnpm and docker children create
 *   files group/world-readable, as on a stock install.
 * - `checkoutWithTrackedModes()` re-applies git's recorded modes after every checkout, so a file
 *   already rewritten 0600 (or a caller that bypassed the entry point) is repaired too.
 *
 * Files that must stay private do not rely on the umask: their writers set 0600/0700 explicitly
 * (secret-files.ts, backup-encryption.ts, backup-destination.ts), which a umask can only narrow.
 */
import { chmodSync, lstatSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

/** The umask operator commands run with: owner-writable, readable by everyone. */
export const OPERATOR_UMASK = 0o022;

/** Sets the process umask that every child command inherits. Returns the previous one. */
export function useOperatorUmask(): number {
  return process.umask(OPERATOR_UMASK);
}

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}
type Runner = (command: string, args: string[], env?: NodeJS.ProcessEnv) => RunResult;

/** File permission bits for a git index mode; null for symlinks and submodules (no mode). */
function permissionsFor(gitMode: string): number | null {
  if (gitMode === '100644') return 0o644;
  if (gitMode === '100755') return 0o755;
  return null;
}

export interface ModeRepair {
  changed: number;
  /** Tracked files whose mode could not be set (not owned by this user); never their contents. */
  failed: string[];
}

/**
 * Re-applies git's recorded mode to every tracked regular file whose permission bits differ
 * (100644 -> 0644, 100755 -> 0755). Throws when git cannot list the index, so a broken repair is
 * never mistaken for a clean tree. A file it cannot chmod is reported, not fatal: a rollback must
 * not stop at a file the checkout itself could still write.
 */
export function restoreTrackedModes(run: Runner): ModeRepair {
  const top = run('git', ['rev-parse', '--show-toplevel']);
  const listed = run('git', ['ls-files', '--stage', '-z', '--full-name']);
  const root = top.stdout.trim();
  if (top.status !== 0 || listed.status !== 0 || !isAbsolute(root))
    throw new Error('restore tracked file modes failed: cannot list the git index');
  const repair: ModeRepair = { changed: 0, failed: [] };
  for (const entry of listed.stdout.split('\0')) {
    // `<mode> <object> <stage>\t<path>`
    const tab = entry.indexOf('\t');
    if (tab < 0) continue;
    const want = permissionsFor(entry.slice(0, entry.indexOf(' ')));
    if (want === null) continue;
    const path = join(root, entry.slice(tab + 1));
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (!stat?.isFile() || (stat.mode & 0o777) === want) continue;
    try {
      chmodSync(path, want);
      repair.changed++;
    } catch {
      repair.failed.push(entry.slice(tab + 1));
    }
  }
  return repair;
}

/** `git checkout --detach <ref>`, then `restoreTrackedModes`. Returns the checkout's result. */
export function checkoutWithTrackedModes(
  run: Runner,
  ref: string,
  log: (message: string) => void
): RunResult {
  const checkout = run('git', ['checkout', '--detach', ref]);
  if (checkout.status !== 0) return checkout;
  const { changed, failed } = restoreTrackedModes(run);
  if (changed > 0) log(`restored git file modes on ${changed} tracked files`);
  if (failed.length > 0)
    log(
      `could not restore the git mode of ${failed.length} tracked files (first: ${failed[0]}); ` +
        'run the command as the checkout owner'
    );
  return checkout;
}
