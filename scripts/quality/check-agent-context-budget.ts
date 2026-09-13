import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

type ContextGroup = {
  name: string;
  description: string;
  files: string[];
};

type Measurement = {
  name: string;
  description: string;
  fileCount: number;
  bytes: number;
  lines: number;
  words: number;
  estimatedTokensFourChars: number;
  estimatedTokensThreePointFiveChars: number;
};

function markdownFilesInDirectory(directory: string): string[] {
  try {
    return readdirSync(directory)
      .filter((entry) => entry.endsWith('.md'))
      .map((entry) => join(directory, entry))
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

function existingFiles(files: string[]): string[] {
  return files.filter((file) => {
    try {
      return statSync(file).isFile();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return false;
      }
      throw error;
    }
  });
}

function countLines(text: string): number {
  if (text.length === 0) return 0;
  return text.split('\n').length;
}

function measureGroup(group: ContextGroup): Measurement {
  const files = existingFiles(group.files);
  const text = files.map((file) => readFileSync(file, 'utf8')).join('\n');
  const words = text.trim().length === 0 ? 0 : text.trim().split(/\s+/).length;

  return {
    name: group.name,
    description: group.description,
    fileCount: files.length,
    bytes: Buffer.byteLength(text, 'utf8'),
    lines: countLines(text),
    words,
    estimatedTokensFourChars: Math.ceil(text.length / 4),
    estimatedTokensThreePointFiveChars: Math.ceil(text.length / 3.5),
  };
}

function printTable(measurements: Measurement[]): void {
  const headers = [
    'Surface',
    'Files',
    'Bytes',
    'Lines',
    'Words',
    'Est. tokens @4c',
    'Est. tokens @3.5c',
  ];
  const rows = measurements.map((measurement) => [
    measurement.name,
    measurement.fileCount.toLocaleString(),
    measurement.bytes.toLocaleString(),
    measurement.lines.toLocaleString(),
    measurement.words.toLocaleString(),
    measurement.estimatedTokensFourChars.toLocaleString(),
    measurement.estimatedTokensThreePointFiveChars.toLocaleString(),
  ]);

  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => row[index].length))
  );

  const formatRow = (row: string[]) =>
    row.map((cell, index) => cell.padEnd(widths[index])).join('  ');

  console.log(formatRow(headers));
  console.log(widths.map((width) => '-'.repeat(width)).join('  '));
  for (const row of rows) {
    console.log(formatRow(row));
  }
}

function printDetails(measurements: Measurement[]): void {
  console.log('\nNotes:');
  console.log(
    '- Token counts are estimates for static Markdown surfaces, not provider-billed prompt telemetry.'
  );
  console.log(
    '- @4c is a common rough estimate; @3.5c is a more conservative Markdown/code estimate.'
  );
  console.log(
    '- Scoped rule directories should be read selectively by path and task, not bulk-loaded.'
  );

  console.log('\nMeasured groups:');
  for (const measurement of measurements) {
    console.log(`- ${measurement.name}: ${measurement.description}`);
  }
}

const groups: ContextGroup[] = [
  {
    name: 'codex-startup-docs',
    description: 'Root AGENTS.md plus CLAUDE.md loaded by .codex/config.toml fallback.',
    files: ['AGENTS.md', 'CLAUDE.md'],
  },
  {
    name: 'claude-root-surface',
    description: 'Root CLAUDE.md plus compact root .claude/rules stubs.',
    files: ['CLAUDE.md', ...markdownFilesInDirectory('.claude/rules')],
  },
  {
    name: 'root-rule-stubs',
    description: 'Compact root .claude/rules routing and repo-wide safety rules.',
    files: markdownFilesInDirectory('.claude/rules'),
  },
  {
    name: 'apps-api-entrypoint',
    description: 'apps/api/AGENTS.md only; the cheap API path entrypoint.',
    files: ['apps/api/AGENTS.md'],
  },
  {
    name: 'apps-api-scoped-rules',
    description: 'All apps/api/.claude/rules files; useful as a worst-case bulk-load measurement.',
    files: markdownFilesInDirectory('apps/api/.claude/rules'),
  },
  {
    name: 'apps-api-bulk-surface',
    description:
      'apps/api/AGENTS.md plus every apps/api scoped rule; this should not be startup context.',
    files: ['apps/api/AGENTS.md', ...markdownFilesInDirectory('apps/api/.claude/rules')],
  },
];

const measurements = groups.map(measureGroup);
printTable(measurements);
printDetails(measurements);

const changedRoot = process.cwd();
console.log(`\nRepository: ${relative(changedRoot, changedRoot) || '.'}`);
