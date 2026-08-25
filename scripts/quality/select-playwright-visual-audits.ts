import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_WEB_DIR = 'apps/web';
const PLAYWRIGHT_DIR = 'tests/playwright';
const QUARANTINE_FILE = 'visual-audit-quarantine.txt';

export interface PlaywrightVisualAuditSelection {
  selected: string[];
  quarantined: string[];
}

function repoRootFromCurrentFile(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
}

function compareAlphabetically(left: string, right: string): number {
  return left.localeCompare(right);
}

function parseArgs(argv: string[]): { webDir: string } {
  const webDirArg = argv.find((arg) => arg.startsWith('--web-dir='));
  return { webDir: webDirArg?.slice('--web-dir='.length) || DEFAULT_WEB_DIR };
}

function readQuarantine(quarantinePath: string): string[] {
  const contents = readFileSync(quarantinePath, 'utf8');
  return contents
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

function assertValidQuarantineEntry(entry: string, testsDir: string): void {
  if (entry.includes('/') || entry.includes('\\')) {
    throw new Error(`Invalid Playwright quarantine entry "${entry}": use a basename only.`);
  }
  if (!entry.endsWith('audit.spec.ts')) {
    throw new Error(`Invalid Playwright quarantine entry "${entry}": expected *audit.spec.ts.`);
  }
  if (entry.startsWith('staging-')) {
    throw new Error(`Invalid Playwright quarantine entry "${entry}": staging specs are never part of this CI job.`);
  }

  const absolutePath = path.join(testsDir, entry);
  if (!existsSync(absolutePath) || !statSync(absolutePath).isFile()) {
    throw new Error(`Invalid Playwright quarantine entry "${entry}": file does not exist.`);
  }
}

export function selectPlaywrightVisualAudits(repoRoot: string, webDir = DEFAULT_WEB_DIR): PlaywrightVisualAuditSelection {
  const testsDir = path.join(repoRoot, webDir, PLAYWRIGHT_DIR);
  const quarantinePath = path.join(testsDir, QUARANTINE_FILE);
  const quarantined = readQuarantine(quarantinePath);
  const quarantineSet = new Set<string>();

  for (const entry of quarantined) {
    if (quarantineSet.has(entry)) {
      throw new Error(`Duplicate Playwright quarantine entry "${entry}".`);
    }
    assertValidQuarantineEntry(entry, testsDir);
    quarantineSet.add(entry);
  }

  const selected = readdirSync(testsDir)
    .filter((fileName) => fileName.endsWith('audit.spec.ts'))
    .filter((fileName) => !fileName.startsWith('staging-'))
    .filter((fileName) => !quarantineSet.has(fileName))
    .sort(compareAlphabetically)
    .map((fileName) => path.posix.join(PLAYWRIGHT_DIR, fileName));

  if (selected.length === 0) {
    throw new Error('Playwright visual audit selection is empty. Repair at least one audit before running CI.');
  }

  return { selected, quarantined: [...quarantineSet].sort(compareAlphabetically) };
}

function main(): void {
  const { webDir } = parseArgs(process.argv.slice(2));
  const { selected } = selectPlaywrightVisualAudits(repoRootFromCurrentFile(), webDir);
  process.stdout.write(`${selected.join('\n')}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
