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
 * - `checkoutWithTrackedModes()` makes tracked files world-readable (and 100755 files
 *   world-executable) after every checkout, so a file already rewritten 0600 (or a caller that
 *   bypassed the entry point) is repaired too.
 *
 * Files that must stay private do not rely on the umask: their writers set 0600/0700 explicitly
 * (secret-files.ts, backup-encryption.ts, backup-destination.ts), which a umask can only narrow.
 */
import { chmodSync, lstatSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, sep } from 'node:path';

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

/**
 * The bits everyone needs on a tracked file of this git index mode: read, plus execute for
 * 100755. Null for symlinks and submodules (no mode).
 */
function requiredBitsFor(gitMode: string): number | null {
  if (gitMode === '100644') return 0o444;
  if (gitMode === '100755') return 0o555;
  return null;
}

export interface ModeRepair {
  changed: number;
  /** Tracked paths whose mode could not be set (not owned by this user); never their contents. */
  failed: string[];
}

/**
 * Makes every tracked regular file readable by everyone (and executable by everyone when git
 * records 100755), and every directory holding a tracked file traversable by everyone. Bits are
 * only added, never removed: a file a looser umask made 0664 is left alone, one a umask 077
 * checkout made 0600 becomes 0644. Git records no directory modes, and a checkout under umask
 * 077 creates new directories 0700, which the non-root key agent cannot enter. Throws when git
 * cannot list the index, so a broken repair is never mistaken for a clean tree. A path it cannot
 * chmod is reported, not fatal: a rollback must not stop at a file the checkout could write.
 */
export function restoreTrackedModes(run: Runner): ModeRepair {
  const top = run('git', ['rev-parse', '--show-toplevel']);
  const listed = run('git', ['ls-files', '--stage', '-z', '--full-name']);
  const root = top.stdout.trim();
  if (top.status !== 0 || listed.status !== 0 || !isAbsolute(root))
    throw new Error('restore tracked file modes failed: cannot list the git index');
  const repair: ModeRepair = { changed: 0, failed: [] };
  const realRoot = realpathSync(root);
  /** True when `path` resolves inside the repository (no symlinked parent leads out of it). */
  const inside = (path: string) => {
    const real = realpathSync(dirname(path));
    return real === realRoot || real.startsWith(realRoot + sep);
  };
  // Any error (EACCES, ENOTDIR, a path leaving the repo) is reported, never thrown: the
  // rollback that calls this must not stop at one path.
  const fix = (relative: string, kind: 'file' | 'dir', want: (mode: number) => number) => {
    const path = join(root, relative);
    try {
      const stat = lstatSync(path, { throwIfNoEntry: false });
      if (!stat || !(kind === 'file' ? stat.isFile() : stat.isDirectory())) return;
      if (want(stat.mode & 0o777) === (stat.mode & 0o777)) return;
      if (!inside(path)) throw new Error('outside the repository');
      chmodSync(path, want(stat.mode & 0o777));
      repair.changed++;
    } catch {
      repair.failed.push(relative);
    }
  };
  const directories = new Set<string>();
  for (const entry of listed.stdout.split('\0')) {
    // `<mode> <object> <stage>\t<path>`
    const tab = entry.indexOf('\t');
    if (tab < 0) continue;
    const required = requiredBitsFor(entry.slice(0, entry.indexOf(' ')));
    if (required === null) continue;
    const relative = entry.slice(tab + 1);
    fix(relative, 'file', (mode) => mode | required);
    for (let dir = dirname(relative); dir !== '.'; dir = dirname(dir)) directories.add(dir);
  }
  // Only add group/other read+search; never narrow a directory an operator widened.
  for (const dir of directories) fix(dir, 'dir', (mode) => mode | 0o055);
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
  if (changed > 0) log(`restored git file modes on ${changed} tracked paths`);
  if (failed.length > 0)
    log(
      `could not restore the git mode of ${failed.length} tracked paths (first: ${failed[0]}); ` +
        'run the command as the checkout owner'
    );
  return checkout;
}
