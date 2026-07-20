import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, normalize, relative } from 'node:path';

const root = process.cwd();
const skillsDir = join(root, '.agents/skills');
const markdownPathPattern =
  /(?:`([^`\n]+\.md)`|(?:^|\s)([A-Za-z0-9_.\/-]+\.md))(?![A-Za-z0-9_.\/-])/gm;

const failures: string[] = [];

for (const skillName of readdirSync(skillsDir).sort()) {
  const skillPath = join(skillsDir, skillName, 'SKILL.md');
  if (!existsSync(skillPath)) continue;

  const content = readFileSync(skillPath, 'utf8');
  for (const match of content.matchAll(markdownPathPattern)) {
    const reference = match[1] ?? match[2];
    if (!reference || reference.startsWith('http://') || reference.startsWith('https://')) continue;
    if (reference === '.do-state.md' || reference === '.workflow-state.md') continue;
    if (
      !reference.includes('/') &&
      !reference.startsWith('CLAUDE.md') &&
      !reference.startsWith('AGENTS.md')
    )
      continue;

    const resolved = normalize(join(root, reference));
    const relativeResolved = relative(root, resolved);
    if (relativeResolved.startsWith('..')) {
      failures.push(
        `${relative(root, skillPath)} references ${reference}, which resolves outside the repository`
      );
      continue;
    }

    if (!existsSync(resolved) || !statSync(resolved).isFile()) {
      failures.push(`${relative(root, skillPath)} references missing file ${reference}`);
    }
  }
}

if (failures.length > 0) {
  console.error('Skill wrapper reference check failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('All skill wrapper markdown references resolve to readable files.');
