/**
 * Scenario: Multi-File Refactor
 *
 * Tests the model's ability to rename a function across multiple files.
 * Requires: grep to find all usages, read_file to understand context,
 * edit_file to rename in each file.
 */

import type { EvalScenario, ScenarioRun } from '../types.js';
import { createVirtualFs, makeReadFile, makeEditFile, makeGrep, makeGlob } from '../tools.js';

const FILES = [
  {
    path: 'src/utils/format.ts',
    content: `/**
 * String formatting utilities.
 */

/** Format a date as YYYY-MM-DD */
export function fmtDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return \`\${y}-\${m}-\${d}\`;
}

/** Format a number as currency */
export function fmtCurrency(amount: number, currency = 'USD'): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount);
}
`,
  },
  {
    path: 'src/reports/daily.ts',
    content: `import { fmtDate } from '../utils/format';

export interface DailyReport {
  date: string;
  totalSales: number;
  itemCount: number;
}

export function generateDailyReport(date: Date, sales: number, items: number): DailyReport {
  return {
    date: fmtDate(date),
    totalSales: sales,
    itemCount: items,
  };
}
`,
  },
  {
    path: 'src/reports/export.ts',
    content: `import { fmtDate } from '../utils/format';
import { fmtCurrency } from '../utils/format';
import type { DailyReport } from './daily';

export function exportReportCsv(report: DailyReport): string {
  const header = 'Date,Total Sales,Items';
  const row = \`\${report.date},\${fmtCurrency(report.totalSales)},\${report.itemCount}\`;
  return \`\${header}\\n\${row}\`;
}

export function exportReportFilename(date: Date): string {
  return \`report-\${fmtDate(date)}.csv\`;
}
`,
  },
  {
    path: 'tests/format.test.ts',
    content: `import { fmtDate, fmtCurrency } from '../src/utils/format';

describe('fmtDate', () => {
  it('formats a date correctly', () => {
    const d = new Date(2026, 0, 15);
    expect(fmtDate(d)).toBe('2026-01-15');
  });
});

describe('fmtCurrency', () => {
  it('formats USD', () => {
    expect(fmtCurrency(42.5)).toBe('$42.50');
  });
});
`,
  },
];

const vfs = createVirtualFs(FILES);

const scenario: EvalScenario = {
  id: 'multi-file-refactor',
  name: 'Multi-File Function Rename',
  category: 'coding',
  description:
    'Rename fmtDate to formatDate across 3 source files and 1 test file. Requires grep + multiple edit_file calls.',

  systemPrompt:
    'You are a code refactoring assistant. Use the provided tools to search, read, and edit source files. When renaming, find all usages first, then edit each file.',

  userPrompt:
    'Rename the function `fmtDate` to `formatDate` across the entire codebase. Make sure to update the definition, all imports, and all call sites.',

  tools: [makeReadFile(vfs), makeEditFile(vfs), makeGrep(vfs), makeGlob(vfs)],

  maxTurns: 12,

  evaluate: (run: ScenarioRun) => {
    // Check that edit_file was used on at least 3 files
    const editedFiles = new Set(
      run.toolCalls
        .filter((tc) => tc.toolName === 'edit_file' && !tc.isError)
        .map((tc) => String(tc.arguments.path)),
    );

    // Check the vfs state after edits
    const formatTsContent = vfs.get('src/utils/format.ts') ?? '';
    const dailyTsContent = vfs.get('src/reports/daily.ts') ?? '';
    const exportTsContent = vfs.get('src/reports/export.ts') ?? '';
    const testContent = vfs.get('tests/format.test.ts') ?? '';

    const checks = [
      {
        name: 'used_grep',
        pass: run.toolCalls.some((tc) => tc.toolName === 'grep'),
        detail: 'Model should grep for fmtDate to find all usages',
      },
      {
        name: 'edited_definition',
        pass: formatTsContent.includes('function formatDate') && !formatTsContent.includes('function fmtDate'),
        detail: 'Function definition in format.ts should be renamed',
      },
      {
        name: 'edited_daily_import',
        pass: dailyTsContent.includes('formatDate') && !dailyTsContent.includes('fmtDate'),
        detail: 'Import and usage in daily.ts should be renamed',
      },
      {
        name: 'edited_export_import',
        pass: exportTsContent.includes('formatDate') && !exportTsContent.includes('fmtDate'),
        detail: 'Import and usage in export.ts should be renamed',
      },
      {
        name: 'edited_test',
        pass: testContent.includes('formatDate') && !testContent.includes('fmtDate'),
        detail: 'Test file should use the new name',
      },
      {
        name: 'edited_multiple_files',
        pass: editedFiles.size >= 3,
        detail: `Should edit at least 3 files (edited: ${editedFiles.size})`,
      },
      {
        name: 'completed',
        pass: run.stopReason === 'complete',
        detail: 'Model should complete the task',
      },
    ];

    const allPassed = checks.every((c) => c.pass);
    return {
      pass: allPassed,
      reason: allPassed
        ? 'Successfully renamed fmtDate to formatDate across all files'
        : `Failed checks: ${checks.filter((c) => !c.pass).map((c) => c.name).join(', ')}`,
      checks,
    };
  },
};

export default scenario;
