import { execFileSync } from 'node:child_process';

const GIT_BIN = '/usr/bin/git';

const forbiddenRuntimeStatePaths = ['.do-state.md', '.workflow-state.md'];

function gitLines(args: string[]): string[] {
  return execFileSync(GIT_BIN, args, { encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

const tracked = new Set(gitLines(['ls-files', ...forbiddenRuntimeStatePaths]));
const staged = new Set(
  gitLines(['diff', '--cached', '--name-only', '--', ...forbiddenRuntimeStatePaths])
);

const violations = [...new Set([...tracked, ...staged])].sort();

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
