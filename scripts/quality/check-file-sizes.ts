/**
 * File Size Quality Check
 *
 * Enforces the 800-line mandatory split threshold from .claude/rules/18-file-size-limits.md.
 * Files exceeding 800 lines (excluding tests and exempted files) cause a CI failure.
 *
 * Usage:
 *   pnpm tsx scripts/quality/check-file-sizes.ts [--json]
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = process.env.QUALITY_FILE_SIZE_ROOT
  ? resolve(process.env.QUALITY_FILE_SIZE_ROOT)
  : resolve(import.meta.dirname, '../..');
const HARD_LIMIT = 800;
const WARN_LIMIT = 500;
const DEBT_REPORT_LIMIT = 800;

// Files with documented exceptions (must have FILE SIZE EXCEPTION comment)
const EXEMPT_PATTERNS = [
  /\.test\./,
  /\.spec\./,
  /_test\.go$/,
  /\/dist\//,
  /\/node_modules\//,
  /\.generated\./,
];

// Specific files with documented exemptions or pre-existing tech debt.
// Pre-existing files are tracked here to prevent NEW violations while allowing
// gradual cleanup. When splitting a file below, remove it from this list.
const EXEMPT_FILES = new Set([
  'apps/api/src/db/schema.ts', // Database schema — splitting creates import complexity
  // Pre-existing Go files (tracked for future splitting)
  'packages/vm-agent/internal/bootstrap/bootstrap.go',
  'packages/vm-agent/internal/acp/session_host.go',
  'packages/vm-agent/internal/server/server.go',
  'packages/vm-agent/internal/acp/gateway.go',
  'packages/vm-agent/internal/server/workspaces.go',
  // Pre-existing TypeScript files (tracked for future splitting)
  'apps/api/src/index.ts',
  'apps/api/src/routes/projects/crud.ts',
  'apps/api/src/scheduled/stuck-tasks.ts',
  'packages/terminal/src/MultiTerminal.tsx',
  'packages/acp-client/src/hooks/useAcpSession.ts',
]);

type FileSizeFinding = {
  file: string;
  lines: number;
  severity: 'error' | 'warning';
  reason?: string;
};

function isTestFile(relPath: string): boolean {
  return /\.test\./.test(relPath) || /\.spec\./.test(relPath) || /_test\.go$/.test(relPath);
}

function listSourceFiles(): string[] {
  return execSync('find apps/ packages/ -type f', { cwd: ROOT, encoding: 'utf-8' })
    .trim()
    .split('\n')
    .filter((file) => /\.(ts|tsx|go)$/.test(file))
    .filter((file) => !file.includes('/node_modules/'))
    .filter((file) => !file.includes('/dist/'))
    .filter((file) => !file.endsWith('.d.ts'));
}

function readSourceFile(relPath: string): string | null {
  try {
    return readFileSync(resolve(ROOT, relPath), 'utf-8');
  } catch {
    return null;
  }
}

function sortFindings(findings: FileSizeFinding[]): FileSizeFinding[] {
  return findings.sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === 'error' ? -1 : 1;
    return b.lines - a.lines;
  });
}

function collectEnforcedFindings(files: string[]): FileSizeFinding[] {
  const violations: FileSizeFinding[] = [];

  for (const relPath of files) {
    if (EXEMPT_PATTERNS.some((p) => p.test(relPath))) continue;
    if (EXEMPT_FILES.has(relPath)) continue;

    const content = readSourceFile(relPath);
    if (content === null) continue;

    const lineCount = content.split('\n').length;

    if (lineCount > HARD_LIMIT) {
      if (content.includes('FILE SIZE EXCEPTION:')) continue;
      violations.push({ file: relPath, lines: lineCount, severity: 'error' });
    } else if (lineCount > WARN_LIMIT) {
      violations.push({ file: relPath, lines: lineCount, severity: 'warning' });
    }
  }

  return sortFindings(violations);
}

function collectDebtReport(files: string[]): FileSizeFinding[] {
  const findings: FileSizeFinding[] = [];

  for (const relPath of files) {
    const content = readSourceFile(relPath);
    if (content === null) continue;

    const lineCount = content.split('\n').length;
    if (lineCount <= DEBT_REPORT_LIMIT) continue;

    if (EXEMPT_FILES.has(relPath)) {
      findings.push({
        file: relPath,
        lines: lineCount,
        severity: 'warning',
        reason: 'known oversized source exemption',
      });
    } else if (isTestFile(relPath)) {
      findings.push({
        file: relPath,
        lines: lineCount,
        severity: 'warning',
        reason: 'oversized test file; exempt from hard source gate',
      });
    }
  }

  return sortFindings(findings);
}

function main(): void {
  const json = process.argv.includes('--json');

  const reportDebt = process.argv.includes('--report-debt');

  const files = listSourceFiles();
  const violations = reportDebt ? collectDebtReport(files) : collectEnforcedFindings(files);

  const errors = violations.filter((v) => v.severity === 'error');
  const warnings = violations.filter((v) => v.severity === 'warning');

  if (json) {
    console.log(JSON.stringify(violations, null, 2));
  } else {
    if (reportDebt) {
      console.log(
        `File size debt report: ${warnings.length} known oversized source/test files above ${DEBT_REPORT_LIMIT} lines.`
      );
      for (const w of warnings) {
        console.log(`  ${w.file}: ${w.lines} lines (${w.reason})`);
      }
    } else if (errors.length === 0) {
      console.log(`File size check passed. No files exceed ${HARD_LIMIT} lines.`);
      if (warnings.length > 0) {
        console.log(
          `\n${warnings.length} files between ${WARN_LIMIT}-${HARD_LIMIT} lines (consider splitting):`
        );
        for (const w of warnings) {
          console.log(`  ${w.file}: ${w.lines} lines`);
        }
      }
    } else {
      console.error(
        `\nFile size check FAILED. ${errors.length} files exceed ${HARD_LIMIT} lines:\n`
      );
      for (const e of errors) {
        console.error(`  ${e.file}: ${e.lines} lines (limit: ${HARD_LIMIT})`);
      }
      console.error(`\nSplit these files per .claude/rules/18-file-size-limits.md`);
      console.error(`Or add a "// FILE SIZE EXCEPTION: <reason>" comment if exempted.\n`);
    }
  }

  process.exit(errors.length > 0 ? 1 : 0);
}

main();
