import { execFileSync } from 'node:child_process';
import { isAbsolute } from 'node:path';

const DEFAULT_GIT_BIN = '/usr/bin/git';
const GIT_BIN = process.env.SAM_GIT_BINARY ?? DEFAULT_GIT_BIN;

if (!isAbsolute(GIT_BIN)) {
  console.error('SAM_GIT_BINARY must be an absolute path to a trusted Git executable.');
  process.exit(1);
}

const forbiddenRuntimeStatePaths = [':(glob)**/.do-state.md', ':(glob)**/.workflow-state.md'];

function gitLines(args: string[]): string[] {
  return execFileSync(GIT_BIN, args, { encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

const tracked = new Set(gitLines(['ls-files', '--cached', '--', ...forbiddenRuntimeStatePaths]));
const staged = new Set(
  gitLines([
    'diff',
    '--cached',
    '--diff-filter=ACMR',
    '--name-only',
    '--',
    ...forbiddenRuntimeStatePaths,
  ])
);

const violations = [...new Set([...tracked, ...staged])].sort((a, b) => a.localeCompare(b));

if (violations.length > 0) {
  console.error(
    [
      'Runtime workflow state files must remain local-only.',
      '',
      'These files are deliberately visible to SAM sleep snapshots, but they must not be committed:',
      ...violations.map((path) => `- ${path}`),
      '',
      'Unstage/remove them from git and keep them as workspace-local runtime state.',
    ].join('\n')
  );
  process.exit(1);
}

console.log('Runtime workflow state file check passed.');
