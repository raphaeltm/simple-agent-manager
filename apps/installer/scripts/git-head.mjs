import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const read = (path) => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
};

/**
 * The commit checked out in the repository containing `from`, or '' when there is none.
 * Reads Git's files instead of running `git`, so nothing is resolved through PATH.
 * Handles a detached HEAD, a branch (loose or packed ref) and linked worktrees.
 */
export function checkedOutCommit(from = fileURLToPath(new URL('.', import.meta.url))) {
  let directory = resolve(from);
  let dotGit = '';
  for (;;) {
    const candidate = join(directory, '.git');
    if (existsSync(candidate)) {
      dotGit = candidate;
      break;
    }
    const parent = dirname(directory);
    if (parent === directory) return '';
    directory = parent;
  }
  let gitDirectory = dotGit;
  if (!statSync(dotGit).isDirectory()) {
    // A linked worktree or submodule: ".git" is a file naming the real directory.
    const pointer = /^gitdir: (.+)$/m.exec(read(dotGit))?.[1]?.trim();
    if (!pointer) return '';
    gitDirectory = isAbsolute(pointer) ? pointer : resolve(directory, pointer);
  }
  const head = read(join(gitDirectory, 'HEAD')).trim();
  if (/^[a-f0-9]{40}$/.test(head)) return head;
  const reference = /^ref: (refs\/[A-Za-z0-9._/-]+)$/.exec(head)?.[1];
  if (!reference || reference.includes('..')) return '';
  // Refs of a linked worktree live in the main repository's directory.
  const common = read(join(gitDirectory, 'commondir')).trim();
  const directories = common
    ? [gitDirectory, isAbsolute(common) ? common : resolve(gitDirectory, common)]
    : [gitDirectory];
  for (const candidate of directories) {
    const loose = read(join(candidate, reference)).trim();
    if (/^[a-f0-9]{40}$/.test(loose)) return loose;
  }
  for (const candidate of directories)
    for (const line of read(join(candidate, 'packed-refs')).split('\n')) {
      const [commit, name] = line.split(' ');
      if (name === reference && /^[a-f0-9]{40}$/.test(commit)) return commit;
    }
  return '';
}
