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
import { resolve, relative } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../..');
const HARD_LIMIT = 800;
const WARN_LIMIT = 500;

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
  'packages/terminal/src/MultiTerminal.tsx',
  'packages/acp-client/src/hooks/useAcpSession.ts',
]);

function main(): void {
  const json = process.argv.includes('--json');

  // Find all source files
  const cmd = `find apps/ packages/ -type f \\( -name '*.ts' -o -name '*.tsx' -o -name '*.go' \\) | grep -v node_modules | grep -v dist | grep -v '.d.ts'`;
  const files = execSync(cmd, { cwd: ROOT, encoding: 'utf-8' })
    .trim()
    .split('\n')
    .filter(Boolean);

  const violations: Array<{ file: string; lines: number; severity: 'error' | 'warning' }> = [];

  for (const file of files) {
    const relPath = file; // already relative from find command

    // Skip test files
    if (EXEMPT_PATTERNS.some((p) => p.test(relPath))) continue;

    // Skip specifically exempted files
    if (EXEMPT_FILES.has(relPath)) continue;

    const fullPath = resolve(ROOT, relPath);
    let content: string;
    try {
      content = readFileSync(fullPath, 'utf-8');
    } catch {
      continue;
    }

    const lineCount = content.split('\n').length;

    if (lineCount > HARD_LIMIT) {
      // Check if file has a documented exception comment
      if (content.includes('FILE SIZE EXCEPTION:')) continue;

      violations.push({ file: relPath, lines: lineCount, severity: 'error' });
    } else if (lineCount > WARN_LIMIT) {
      violations.push({ file: relPath, lines: lineCount, severity: 'warning' });
    }
  }

  // Sort: errors first, then by line count descending
  violations.sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === 'error' ? -1 : 1;
    return b.lines - a.lines;
  });

  const errors = violations.filter((v) => v.severity === 'error');
  const warnings = violations.filter((v) => v.severity === 'warning');

  if (json) {
    console.log(JSON.stringify(violations, null, 2));
  } else {
    if (errors.length === 0) {
      console.log(`File size check passed. No files exceed ${HARD_LIMIT} lines.`);
      if (warnings.length > 0) {
        console.log(`\n${warnings.length} files between ${WARN_LIMIT}-${HARD_LIMIT} lines (consider splitting):`);
        for (const w of warnings) {
          console.log(`  ${w.file}: ${w.lines} lines`);
        }
      }
    } else {
      console.error(`\nFile size check FAILED. ${errors.length} files exceed ${HARD_LIMIT} lines:\n`);
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
