#!/usr/bin/env node
// verify-test-quality.mjs — Stop hook for Claude Code and Codex (rule 35, vertical slice tests).
//
// At the end of a turn it looks at everything this branch changes (commits since the merge
// base with the default branch, staged, unstaged and untracked files) and reports:
//
//   untested-boundary-change  Cross-boundary source changed (API routes, services, Durable
//                             Objects, worker packages, web data hooks, VM agent server),
//                             and no test in the tests that cover that code changed.
//   shallow-test              A changed test file is mostly empty mocks (`mockResolvedValue({})`
//                             and the like) with no realistic state.
//
// Each class has a delivery mode (FINDING_MODES). "feedback" asks the agent once per
// session and set of findings: the turn continues with the findings as the prompt, and the
// agent fixes them or says why no test is needed. "block" keeps asking while the findings
// stand, up to BLOCK_LIMIT times, so a false positive can never trap a session.
//
// Output: `{}` lets the turn end; `{"decision":"block","reason":...}` continues it. Both
// harnesses document exactly this for Stop (code.claude.com/docs/en/hooks,
// developers.openai.com/codex/hooks). Every error path prints `{}` and exits 0: the gate
// must never break a session. Node built-ins only, so it runs without node_modules.

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** How each finding class is delivered. Set from measurements recorded in scripts/quality/README.md. */
export const FINDING_MODES = {
  'untested-boundary-change': 'feedback',
  'shallow-test': 'block',
};

/** Consecutive blocks for one unchanged set of "block" findings before the gate lets go. */
export const BLOCK_LIMIT = 3;

const SOURCE_EXTENSION = /\.(ts|tsx|go)$/;
const TEST_FILE = /(\.(test|spec)\.(ts|tsx)$)|(_test\.go$)/;
const TEST_DIR = /(^|\/)(tests?|__tests__|testdata|fixtures|mocks)\//;

const WORKER_PACKAGES = [
  'project-data',
  'operations',
  'app-deployment',
  'ai-proxy',
  'agent-email',
  'repo-hosting',
];

/**
 * Where cross-boundary code lives, and which test locations cover it. A change to one of
 * these sources is "tested" when a test under one of its areas changed too.
 */
const BOUNDARY_AREAS = [
  {
    source: /^apps\/api\/src\/(routes|services|durable-objects|scheduled)\//,
    tests: ['apps/api/tests/', 'apps/api/src/'],
  },
  {
    source: new RegExp(`^packages/(${WORKER_PACKAGES.join('|')})/src/`),
    // Worker packages are exercised through apps/api tests via their ./internal entries.
    tests: (path) => [`${path.split('/').slice(0, 2).join('/')}/`, 'apps/api/tests/'],
  },
  {
    source: /^apps\/web\/src\/(hooks\/use[^/]*|lib\/api\/[^/]*)\.(ts|tsx)$/,
    tests: ['apps/web/tests/', 'apps/web/src/'],
  },
  {
    source: /^packages\/vm-agent\/internal\/server\//,
    tests: ['packages/vm-agent/internal/'],
  },
];

export function isTestFile(path) {
  return TEST_FILE.test(path) || (TEST_DIR.test(path) && SOURCE_EXTENSION.test(path));
}

/** The test locations that cover a boundary source file, or null when it is not boundary code. */
export function boundaryTestAreas(path) {
  if (!SOURCE_EXTENSION.test(path) || path.endsWith('.d.ts') || isTestFile(path)) return null;
  for (const area of BOUNDARY_AREAS) {
    if (!area.source.test(path)) continue;
    return typeof area.tests === 'function' ? area.tests(path) : area.tests;
  }
  return null;
}

const SHALLOW_PATTERN =
  /mock(Resolved|Returned)?Value(Once)?\(\s*\{\s*\}\s*\)|mockReturnValue\(\s*\{\s*\}\s*\)|as unknown as \{\s*\}/g;
const REALISTIC_PATTERN =
  /mockResolvedValue(Once)?\(\s*\{\s*[A-Za-z_]|createSqliteD1|createSchemaTables|createMock|makeFake|createTest|factory|fixture|SELF\.fetch|app\.request\(/g;

/** Findings for a set of changed paths. `readFile` returns file text, or null if unreadable. */
export function evaluate(changed, readFile) {
  const tests = changed.filter(isTestFile);
  const findings = [];
  const untested = [];
  for (const path of changed) {
    const areas = boundaryTestAreas(path);
    if (!areas) continue;
    const covered = tests.some((test) => areas.some((area) => test.startsWith(area)));
    if (!covered) untested.push(path);
  }
  if (untested.length > 0) {
    findings.push({ kind: 'untested-boundary-change', files: untested.sort() });
  }
  const shallow = [];
  for (const path of tests) {
    if (!/\.(ts|tsx)$/.test(path)) continue;
    const text = readFile(path);
    if (text === null) continue;
    const empty = (text.match(SHALLOW_PATTERN) ?? []).length;
    const realistic = (text.match(REALISTIC_PATTERN) ?? []).length;
    if (empty > 2 && realistic === 0) shallow.push(`${path} (${empty} empty mocks)`);
  }
  if (shallow.length > 0) findings.push({ kind: 'shallow-test', files: shallow.sort() });
  return findings;
}

export function renderReason(findings) {
  const lines = ['Test-quality gate (.claude/hooks/verify-test-quality.mjs, rule 35):'];
  for (const finding of findings) {
    const shown = finding.files.slice(0, 15).map((file) => `  - ${file}`);
    if (finding.files.length > 15) shown.push(`  - +${finding.files.length - 15} more`);
    if (finding.kind === 'untested-boundary-change') {
      lines.push(
        '',
        'Cross-boundary source changed on this branch, but no test that covers it changed:',
        ...shown
      );
    } else {
      lines.push(
        '',
        'Changed tests that are mostly empty mocks with no realistic state:',
        ...shown
      );
    }
  }
  lines.push(
    '',
    'Add or update a test that drives the real entry point with realistic state (.claude/rules/35-vertical-slice-testing.md, .claude/rules/62-tests-must-observe-the-real-trigger.md).',
    'If no test is needed (a comment, rename or pure move with existing coverage), say so and why in your reply instead.'
  );
  return lines.join('\n');
}

function git(root, args) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    maxBuffer: 64 * 1024 * 1024,
    timeout: 15_000,
  });
}

function nulList(text) {
  return text.split('\0').filter((entry) => entry.length > 0);
}

function defaultBase(root) {
  for (const ref of ['origin/main', 'main', 'origin/master', 'master']) {
    try {
      git(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
      return ref;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

/** Every path this branch changes: committed since the merge base, staged, unstaged, untracked. */
export function changedFiles(root) {
  const paths = new Set();
  const base = defaultBase(root);
  if (base) {
    try {
      const mergeBase = git(root, ['merge-base', 'HEAD', base]).trim();
      for (const path of nulList(
        git(root, ['diff', '--name-only', '-z', '--diff-filter=ACMR', mergeBase, 'HEAD'])
      )) {
        paths.add(path);
      }
    } catch {
      // No common history: fall back to the working tree only.
    }
  }
  for (const path of nulList(
    git(root, ['diff', '--name-only', '-z', '--diff-filter=ACMR', 'HEAD'])
  )) {
    paths.add(path);
  }
  for (const path of nulList(git(root, ['ls-files', '-z', '--others', '--exclude-standard']))) {
    paths.add(path);
  }
  return [...paths].sort();
}

function readRepoFile(root) {
  return (path) => {
    try {
      return readFileSync(join(root, path), 'utf8');
    } catch {
      return null;
    }
  };
}

function stateFile(root, sessionId) {
  const key = String(sessionId || 'unknown').replaceAll(/[^A-Za-z0-9._-]/g, '_');
  return join(root, '.tmp/stop-gate', `${key}.json`);
}

function readState(file) {
  try {
    const state = JSON.parse(readFileSync(file, 'utf8'));
    return { fingerprint: String(state.fingerprint ?? ''), count: Number(state.count) || 0 };
  } catch {
    return { fingerprint: '', count: 0 };
  }
}

function writeState(file, state) {
  try {
    mkdirSync(dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(state));
    renameSync(temporary, file);
  } catch {
    // State is best effort; without it the gate may repeat feedback, never loop forever
    // in one turn, because stop_hook_active plus the limit below still applies per run.
  }
}

/**
 * Decide the hook output. `previous` is what this session was last told. Feedback findings
 * are delivered once per distinct set; block findings repeat up to BLOCK_LIMIT times.
 */
export function decide(findings, previous) {
  if (findings.length === 0) return { output: {}, state: { fingerprint: '', count: 0 } };
  const fingerprint = JSON.stringify(findings);
  const blocking = findings.some((finding) => FINDING_MODES[finding.kind] === 'block');
  const limit = blocking ? BLOCK_LIMIT : 1;
  const count = previous.fingerprint === fingerprint ? previous.count : 0;
  if (count >= limit) {
    return {
      output: {
        systemMessage: `Test-quality gate: ${findings.map((f) => f.kind).join(', ')} still open after ${count} reminder(s); not blocking again.`,
      },
      state: { fingerprint, count },
    };
  }
  return {
    output: { decision: 'block', reason: renderReason(findings) },
    state: { fingerprint, count: count + 1 },
  };
}

export function run(input, root = SCRIPT_ROOT) {
  const findings = evaluate(changedFiles(root), readRepoFile(root));
  const file = stateFile(root, input.session_id);
  const { output, state } = decide(findings, readState(file));
  writeState(file, state);
  return output;
}

function main() {
  let output = {};
  try {
    const raw = readFileSync(0, 'utf8');
    const input = raw.trim() ? JSON.parse(raw) : {};
    output = run(input);
  } catch {
    output = {};
  }
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch {
    process.stdout.write('{}\n');
  }
  process.exitCode = 0;
}
