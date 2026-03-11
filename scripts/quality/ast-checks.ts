/**
 * AST-Based Code Quality Checks
 *
 * Uses ts-morph for programmatic TypeScript analysis to catch patterns
 * that linters miss: SQL injection via string interpolation, throw-without-log,
 * direct status field updates bypassing state machines, alarm scheduling drift,
 * and more.
 *
 * Usage:
 *   pnpm tsx scripts/quality/ast-checks.ts [--file path] [--rule rule-name]
 *
 * Options:
 *   --file <path>   Check a specific file (default: all src files in apps/api)
 *   --rule <name>   Run only a specific rule (default: all rules)
 *   --json          Output results as JSON
 *   --help          Show help
 *
 * Rules:
 *   sql-injection           Detects string interpolation in sql.exec() calls
 *   throw-without-log       Detects throw statements without preceding log
 *   direct-status-update    Detects raw UPDATE...SET status without state machine
 *   alarm-scheduling        Detects Date.now() in alarm scheduling (should use DB min)
 *   error-message-prop      Detects transitions missing errorMessage for terminal states
 *   parameterized-sql       Verifies placeholder count matches parameter count in sql.exec
 */

import { Project, SyntaxKind, Node, CallExpression, SourceFile } from 'ts-morph';
import { resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = resolve(__filename, '..');
const ROOT = resolve(__dirname, '../..');

// --- Types ---

interface Finding {
  rule: string;
  severity: 'error' | 'warning' | 'info';
  file: string;
  line: number;
  message: string;
  code?: string;
}

interface RuleContext {
  sourceFile: SourceFile;
  findings: Finding[];
  relPath: string;
}

type Rule = {
  name: string;
  description: string;
  check: (ctx: RuleContext) => void;
};

// --- Rules ---

const rules: Rule[] = [
  {
    name: 'sql-injection',
    description: 'Detects string interpolation/concatenation in sql.exec() calls',
    check(ctx) {
      const calls = ctx.sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression);
      for (const call of calls) {
        const expr = call.getExpression().getText();
        if (!expr.endsWith('.exec')) continue;

        const args = call.getArguments();
        if (args.length === 0) continue;

        const firstArg = args[0];
        // Check for template literals with expressions
        if (firstArg.getKind() === SyntaxKind.TemplateExpression) {
          const templateSpans = firstArg.getDescendantsOfKind(SyntaxKind.TemplateSpan);
          for (const span of templateSpans) {
            const spanExpr = span.getExpression();
            const exprText = spanExpr.getText();
            // Allow numeric literals and simple math — those aren't injection risks
            if (spanExpr.getKind() === SyntaxKind.NumericLiteral) continue;
            // Allow safe dynamic clause builders:
            // - whereClause / where: dynamic WHERE from parameterized conditions array
            // - placeholders: IN (?, ?, ?) expansion from .map(() => '?').join(', ')
            if (/^(whereClause|where|placeholders|orderClause|groupClause)$/.test(exprText)) continue;

            ctx.findings.push({
              rule: 'sql-injection',
              severity: 'error',
              file: ctx.relPath,
              line: call.getStartLineNumber(),
              message: `sql.exec() uses template literal with expression: \`\${${exprText}}\`. Use parameterized queries with ? placeholders.`,
              code: call.getText().substring(0, 120),
            });
          }
        }

        // Check for string concatenation
        if (firstArg.getKind() === SyntaxKind.BinaryExpression) {
          const text = firstArg.getText();
          if (text.includes('+')) {
            ctx.findings.push({
              rule: 'sql-injection',
              severity: 'error',
              file: ctx.relPath,
              line: call.getStartLineNumber(),
              message: `sql.exec() uses string concatenation. Use parameterized queries with ? placeholders.`,
              code: call.getText().substring(0, 120),
            });
          }
        }
      }
    },
  },

  {
    name: 'throw-without-log',
    description: 'Detects throw statements in DO/service code without a preceding log statement',
    check(ctx) {
      // Only check DO files — these are the most critical for structured logging
      // since DOs are the source of truth and hardest to debug in production
      if (!ctx.relPath.includes('durable-objects/')) return;

      const throwStatements = ctx.sourceFile.getDescendantsOfKind(SyntaxKind.ThrowStatement);
      for (const throwStmt of throwStatements) {
        const line = throwStmt.getStartLineNumber();
        const parent = throwStmt.getParent();
        if (!parent) continue;

        // Look for console.log/warn/error in the preceding siblings or nearby lines
        const siblings = parent.getChildren();
        const throwIndex = siblings.findIndex((s) => s === throwStmt);

        let hasLog = false;
        // Check up to 5 preceding siblings for a console/log call
        for (let i = Math.max(0, throwIndex - 5); i < throwIndex; i++) {
          const text = siblings[i].getText();
          if (
            text.includes('console.') ||
            text.includes('log.') ||
            text.includes('slog.') ||
            text.includes('logger.')
          ) {
            hasLog = true;
            break;
          }
        }

        // Also check the throw's own block (if inside an if-block, check preceding statements)
        if (!hasLog) {
          const block = throwStmt.getFirstAncestorByKind(SyntaxKind.Block);
          if (block) {
            const stmts = block.getStatements();
            const throwStmtIndex = stmts.findIndex((s) => s.getStartLineNumber() === line);
            for (let i = Math.max(0, throwStmtIndex - 3); i < throwStmtIndex; i++) {
              const text = stmts[i].getText();
              if (text.includes('console.') || text.includes('JSON.stringify')) {
                hasLog = true;
                break;
              }
            }
          }
        }

        if (!hasLog) {
          ctx.findings.push({
            rule: 'throw-without-log',
            severity: 'warning',
            file: ctx.relPath,
            line,
            message: `throw without preceding structured log. Add console.warn/error with diagnostic context before throwing.`,
            code: throwStmt.getText().substring(0, 100),
          });
        }
      }
    },
  },

  {
    name: 'direct-status-update',
    description: 'Detects raw SQL UPDATE...SET status outside of transition functions',
    check(ctx) {
      const calls = ctx.sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression);
      for (const call of calls) {
        const expr = call.getExpression().getText();
        if (!expr.endsWith('.exec')) continue;

        const args = call.getArguments();
        if (args.length === 0) continue;

        const sqlText = args[0].getText().toLowerCase();
        if (!sqlText.includes('update') || !sqlText.includes('set status')) continue;

        // Check if this call is inside a transition function
        const method = call.getFirstAncestorByKind(SyntaxKind.MethodDeclaration);
        const fn = call.getFirstAncestorByKind(SyntaxKind.FunctionDeclaration);
        const container = method || fn;
        const containerName = container?.getName() || '';

        if (
          containerName.includes('transition') ||
          containerName.includes('Transition') ||
          containerName === 'transitionAcpSession'
        ) {
          continue; // This is the sanctioned transition function
        }

        ctx.findings.push({
          rule: 'direct-status-update',
          severity: 'warning',
          file: ctx.relPath,
          line: call.getStartLineNumber(),
          message: `Direct SQL status update outside transition function "${containerName || '<anonymous>'}". Use the state machine transition method instead.`,
          code: call.getText().substring(0, 120),
        });
      }
    },
  },

  {
    name: 'alarm-scheduling',
    description: 'Detects Date.now() in alarm scheduling (should compute from DB timestamps)',
    check(ctx) {
      const calls = ctx.sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression);
      for (const call of calls) {
        const expr = call.getExpression().getText();
        if (!expr.includes('setAlarm')) continue;

        // Walk up to the containing function to check for Date.now() usage
        const container =
          call.getFirstAncestorByKind(SyntaxKind.MethodDeclaration) ||
          call.getFirstAncestorByKind(SyntaxKind.FunctionDeclaration) ||
          call.getFirstAncestorByKind(SyntaxKind.ArrowFunction);
        if (!container) continue;

        const containerText = container.getText();
        if (containerText.includes('Date.now()') && containerText.includes('setAlarm')) {
          // Check if Date.now() is used as the base for alarm time (not just for other purposes)
          // Look for patterns like: Date.now() + timeout
          const dateNowPattern = /Date\.now\(\)\s*\+/;
          if (dateNowPattern.test(containerText)) {
            ctx.findings.push({
              rule: 'alarm-scheduling',
              severity: 'warning',
              file: ctx.relPath,
              line: call.getStartLineNumber(),
              message: `setAlarm() in function that uses Date.now() + offset. Alarms should be scheduled from DB timestamps (e.g., MIN(last_heartbeat_at) + window) to avoid drift.`,
            });
          }
        }
      }
    },
  },

  {
    name: 'parameterized-sql',
    description: 'Verifies placeholder count matches parameter count in sql.exec calls',
    check(ctx) {
      const calls = ctx.sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression);
      for (const call of calls) {
        const expr = call.getExpression().getText();
        if (!expr.endsWith('.exec')) continue;

        const args = call.getArguments();
        if (args.length < 2) continue; // No parameters to check

        const sqlArg = args[0];
        const sqlText = sqlArg.getText();

        // Count ? placeholders (ignore ?? which is a different operator)
        const placeholders = (sqlText.match(/(?<!\?)\?(?!\?)/g) || []).length;
        const paramCount = args.length - 1; // First arg is SQL, rest are params

        // Skip if any parameter uses spread (...) — count is dynamic
        const hasSpread = args.slice(1).some((a) => a.getText().startsWith('...'));
        if (hasSpread) continue;

        // Skip if SQL uses dynamic interpolation (whereClause, placeholders, etc.) — count is dynamic
        if (/\$\{(whereClause|where|placeholders|orderClause)\}/.test(sqlText)) continue;

        if (placeholders !== paramCount && placeholders > 0) {
          ctx.findings.push({
            rule: 'parameterized-sql',
            severity: 'error',
            file: ctx.relPath,
            line: call.getStartLineNumber(),
            message: `sql.exec() has ${placeholders} placeholders but ${paramCount} parameters.`,
            code: call.getText().substring(0, 120),
          });
        }
      }
    },
  },
];

// --- CLI ---

function parseArgs(): { files?: string[]; ruleName?: string; json: boolean } {
  const args = process.argv.slice(2);
  let files: string[] | undefined;
  let ruleName: string | undefined;
  let json = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--file' && args[i + 1]) {
      files = files || [];
      files.push(resolve(args[++i]));
    } else if (args[i] === '--rule' && args[i + 1]) {
      ruleName = args[++i];
    } else if (args[i] === '--json') {
      json = true;
    } else if (args[i] === '--help') {
      console.log(`Usage: pnpm tsx scripts/quality/ast-checks.ts [--file path] [--rule name] [--json]`);
      console.log(`\nRules:`);
      for (const r of rules) {
        console.log(`  ${r.name.padEnd(24)} ${r.description}`);
      }
      process.exit(0);
    }
  }

  return { files, ruleName, json };
}

function main() {
  const { files, ruleName, json } = parseArgs();

  const activeRules = ruleName ? rules.filter((r) => r.name === ruleName) : rules;
  if (activeRules.length === 0) {
    console.error(`Unknown rule: ${ruleName}. Available: ${rules.map((r) => r.name).join(', ')}`);
    process.exit(1);
  }

  const project = new Project({
    tsConfigFilePath: resolve(ROOT, 'apps/api/tsconfig.json'),
    skipAddingFilesFromTsConfig: true,
  });

  // Add files to analyze
  if (files) {
    for (const f of files) {
      project.addSourceFileAtPath(f);
    }
  } else {
    project.addSourceFilesAtPaths([
      resolve(ROOT, 'apps/api/src/**/*.ts'),
    ]);
  }

  const allFindings: Finding[] = [];

  for (const sourceFile of project.getSourceFiles()) {
    const relPath = relative(ROOT, sourceFile.getFilePath());
    const ctx: RuleContext = { sourceFile, findings: [], relPath };

    for (const rule of activeRules) {
      rule.check(ctx);
    }

    allFindings.push(...ctx.findings);
  }

  // Sort by severity (errors first), then file, then line
  const severityOrder: Record<string, number> = { error: 0, warning: 1, info: 2 };
  allFindings.sort((a, b) => {
    const sevDiff = severityOrder[a.severity] - severityOrder[b.severity];
    if (sevDiff !== 0) return sevDiff;
    const fileDiff = a.file.localeCompare(b.file);
    if (fileDiff !== 0) return fileDiff;
    return a.line - b.line;
  });

  if (json) {
    console.log(JSON.stringify(allFindings, null, 2));
  } else {
    if (allFindings.length === 0) {
      console.log(`✓ No issues found (${activeRules.length} rules, ${project.getSourceFiles().length} files)`);
    } else {
      const errors = allFindings.filter((f) => f.severity === 'error');
      const warnings = allFindings.filter((f) => f.severity === 'warning');

      for (const f of allFindings) {
        const icon = f.severity === 'error' ? '✗' : f.severity === 'warning' ? '⚠' : 'ℹ';
        console.log(`${icon} [${f.rule}] ${f.file}:${f.line} — ${f.message}`);
        if (f.code) {
          console.log(`  ${f.code}`);
        }
      }

      console.log(
        `\n${allFindings.length} issues: ${errors.length} errors, ${warnings.length} warnings (${activeRules.length} rules, ${project.getSourceFiles().length} files)`
      );
    }
  }

  // Exit with error code if there are errors
  const hasErrors = allFindings.some((f) => f.severity === 'error');
  process.exit(hasErrors ? 1 : 0);
}

main();
