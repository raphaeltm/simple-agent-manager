/**
 * Scenario: Propose a Patch
 *
 * Tests the model's ability to read a file, identify a bug, and propose
 * an edit_file call to fix it.
 */

import type { EvalScenario, ScenarioRun } from '../types.js';
import { createVirtualFs, makeReadFile, makeEditFile, makeGrep, makeGlob } from '../tools.js';

const FILES = [
  {
    path: 'src/utils/validate.ts',
    content: `/**
 * Validates an email address format.
 * Returns true if valid, false otherwise.
 */
export function isValidEmail(email: string): boolean {
  if (!email || email.length === 0) {
    return false;
  }
  // BUG: This regex does not require a dot in the domain part.
  // "user@localhost" passes but should fail for standard email validation.
  const emailRegex = /^[^@]+@[^@]+$/;
  return emailRegex.test(email);
}

/**
 * Validates that a username meets requirements:
 * - 3-20 characters
 * - Alphanumeric and underscores only
 */
export function isValidUsername(username: string): boolean {
  if (!username) return false;
  return /^[a-zA-Z0-9_]{3,20}$/.test(username);
}

/**
 * Validates a password meets minimum requirements:
 * - At least 8 characters
 * - At least one uppercase letter
 * - At least one number
 */
export function isValidPassword(password: string): boolean {
  if (!password || password.length < 8) return false;
  if (!/[A-Z]/.test(password)) return false;
  if (!/[0-9]/.test(password)) return false;
  return true;
}
`,
  },
  {
    path: 'tests/validate.test.ts',
    content: `import { isValidEmail } from '../src/utils/validate';

describe('isValidEmail', () => {
  it('accepts standard emails', () => {
    expect(isValidEmail('user@example.com')).toBe(true);
  });

  it('rejects empty strings', () => {
    expect(isValidEmail('')).toBe(false);
  });

  // This test FAILS because the regex allows "user@localhost"
  it('rejects emails without a domain dot', () => {
    expect(isValidEmail('user@localhost')).toBe(false); // FAILS — returns true
  });
});
`,
  },
];

const vfs = createVirtualFs(FILES);

const scenario: EvalScenario = {
  id: 'propose-patch',
  name: 'Propose a Bug Fix Patch',
  category: 'coding',
  description: 'Model reads code with a known bug, identifies the issue, and proposes an edit to fix it.',

  systemPrompt:
    'You are a code review assistant. Use the provided tools to read, search, and edit source files. When you find a bug, fix it using the edit_file tool.',

  userPrompt:
    'The test "rejects emails without a domain dot" in tests/validate.test.ts is failing. Find the bug and fix it.',

  tools: [makeReadFile(vfs), makeEditFile(vfs), makeGrep(vfs), makeGlob(vfs)],

  maxTurns: 8,

  evaluate: (run: ScenarioRun) => {
    const checks = [
      {
        name: 'read_test_or_source',
        pass: run.toolCalls.some(
          (tc) =>
            tc.toolName === 'read_file' &&
            /validate/i.test(JSON.stringify(tc.arguments)),
        ),
        detail: 'Model should read the test or source file',
      },
      {
        name: 'used_edit_file',
        pass: run.toolCalls.some((tc) => tc.toolName === 'edit_file'),
        detail: 'Model should propose an edit to fix the bug',
      },
      {
        name: 'fix_targets_regex',
        pass: run.toolCalls.some(
          (tc) =>
            tc.toolName === 'edit_file' &&
            /emailRegex|regex|\.\*\\\.|\\\./i.test(JSON.stringify(tc.arguments)),
        ),
        detail: 'The edit should modify the email regex to require a dot in the domain',
      },
      {
        name: 'completed',
        pass: run.stopReason === 'complete',
        detail: 'Model should complete with an explanation',
      },
      {
        name: 'explains_fix',
        pass: run.messages.some(
          (m) =>
            m.role === 'assistant' &&
            !m.tool_calls?.length &&
            m.content != null &&
            /dot|domain|\.\w|regex|pattern/i.test(m.content),
        ),
        detail: 'Answer should explain the regex fix',
      },
    ];

    const allPassed = checks.every((c) => c.pass);
    return {
      pass: allPassed,
      reason: allPassed
        ? 'Successfully identified and fixed the email regex bug'
        : `Failed checks: ${checks
            .filter((c) => !c.pass)
            .map((c) => c.name)
            .join(', ')}`,
      checks,
    };
  },
};

export default scenario;
