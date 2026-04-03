/**
 * Source-Contract Test Detection
 *
 * Detects the prohibited pattern of reading source files as strings in tests
 * and asserting with .toContain(). This pattern creates false confidence —
 * tests pass while features are broken.
 *
 * Prohibited by .claude/rules/02-quality-gates.md:
 *   "Source-contract tests (readFileSync + toContain()) are NOT valid behavioral tests."
 *
 * Usage:
 *   pnpm tsx scripts/quality/check-source-contract-tests.ts [--json]
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../..');

interface Finding {
  file: string;
  line: number;
  pattern: string;
  message: string;
}

function main(): void {
  const json = process.argv.includes('--json');

  // Find all test files
  const cmd = `find apps/ packages/ -type f \\( -name '*.test.ts' -o -name '*.test.tsx' -o -name '*.spec.ts' -o -name '*.spec.tsx' \\) | grep -v node_modules | grep -v dist`;
  const testFiles = execSync(cmd, { cwd: ROOT, encoding: 'utf-8' })
    .trim()
    .split('\n')
    .filter(Boolean);

  const findings: Finding[] = [];

  for (const file of testFiles) {
    const fullPath = resolve(ROOT, file);
    let content: string;
    try {
      content = readFileSync(fullPath, 'utf-8');
    } catch {
      continue;
    }

    const lines = content.split('\n');

    // Pattern 1: readFileSync reading from src/ directories
    const hasReadFileSync = content.includes('readFileSync');
    const readsSrcDir =
      /readFileSync\([^)]*src[/\\]/.test(content) ||
      /readFileSync\(join\([^)]*src/.test(content) ||
      /readSource\(/.test(content);

    if (hasReadFileSync && readsSrcDir) {
      // Find the specific lines
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (
          (/readFileSync/.test(line) && /src[/\\]/.test(line)) ||
          /readSource\(/.test(line)
        ) {
          findings.push({
            file,
            line: i + 1,
            pattern: 'readFileSync-src',
            message: `Test reads source file as string. Use behavioral tests (render + simulate + assert) instead. See .claude/rules/02-quality-gates.md`,
          });
        }
      }
    }

    // Pattern 2: Function that reads source and returns string (like readSource helper)
    const readSourceHelperMatch = content.match(
      /function\s+\w+\([^)]*\):\s*string\s*\{[^}]*readFileSync[^}]*src/s
    );
    if (readSourceHelperMatch) {
      const helperLine = content.substring(0, content.indexOf(readSourceHelperMatch[0])).split('\n').length;
      findings.push({
        file,
        line: helperLine,
        pattern: 'source-reader-helper',
        message: `Helper function reads source files as strings for test assertions. This is a source-contract test pattern.`,
      });
    }

    // Pattern 3: toContain on source-read variables (strongest signal)
    if (readsSrcDir) {
      for (let i = 0; i < lines.length; i++) {
        if (/\.toContain\(/.test(lines[i]) && /expect\(\w*[Ss]ource/.test(lines[i])) {
          findings.push({
            file,
            line: i + 1,
            pattern: 'source-toContain',
            message: `String assertion on source code content. Tests must exercise behavior, not check strings exist.`,
          });
        }
      }
    }
  }

  // Deduplicate by file+line
  const seen = new Set<string>();
  const unique = findings.filter((f) => {
    const key = `${f.file}:${f.line}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  if (json) {
    console.log(JSON.stringify(unique, null, 2));
  } else {
    if (unique.length === 0) {
      console.log(`Source-contract test check passed. No prohibited patterns found in ${testFiles.length} test files.`);
    } else {
      console.error(`\nSource-contract test check FAILED. ${unique.length} violations found:\n`);
      for (const f of unique) {
        console.error(`  ${f.file}:${f.line} [${f.pattern}]`);
        console.error(`    ${f.message}`);
      }
      console.error(`\nSource-contract tests are prohibited. See .claude/rules/02-quality-gates.md`);
      console.error(`Replace with behavioral tests that render components and simulate interactions.\n`);
    }
  }

  process.exit(unique.length > 0 ? 1 : 0);
}

main();
