import { execFileSync } from 'node:child_process';

const gitBinary = '/usr/bin/git';

const forbiddenTrackedPaths = ['packages/vm-agent/vm-agent'];

const trackedPaths = execFileSync(gitBinary, ['ls-files', ...forbiddenTrackedPaths], {
  encoding: 'utf8',
})
  .split('\n')
  .map((line) => line.trim())
  .filter(Boolean);

if (trackedPaths.length > 0) {
  console.error(
    [
      'Generated binary artifacts must not be tracked.',
      '',
      'Remove these paths from git and build them from source into the expected artifact directories:',
      ...trackedPaths.map((path) => `- ${path}`),
    ].join('\n')
  );
  process.exit(1);
}
