/**
 * Source contract tests for TaskRunner DO helper functions.
 *
 * Verifies the helper functions exist in the extracted helpers module
 * and that the DO imports them.
 *
 * For behavioral tests, see task-runner-do-pure-functions.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Read both files to verify extraction and import relationship
const helpersSource = readFileSync(
  resolve(process.cwd(), 'src/durable-objects/task-runner-helpers.ts'),
  'utf8'
);
const doSource = readFileSync(
  resolve(process.cwd(), 'src/durable-objects/task-runner.ts'),
  'utf8'
);

describe('helper function extraction', () => {
  it('DO imports helpers from task-runner-helpers', () => {
    expect(doSource).toContain("from './task-runner-helpers'");
  });

  it('helpers module exports parseEnvInt', () => {
    expect(helpersSource).toContain('export function parseEnvInt(');
  });

  it('helpers module exports computeBackoffMs', () => {
    expect(helpersSource).toContain('export function computeBackoffMs(');
  });

  it('helpers module exports isTransientError', () => {
    expect(helpersSource).toContain('export function isTransientError(');
  });
});

describe('parseEnvInt source contract', () => {
  it('returns fallback for undefined input', () => {
    expect(helpersSource).toContain("if (!value) return fallback");
  });

  it('uses parseInt with radix 10', () => {
    expect(helpersSource).toContain("parseInt(value, 10)");
  });

  it('checks Number.isFinite to catch NaN/Infinity', () => {
    expect(helpersSource).toContain('Number.isFinite(parsed)');
  });
});

describe('computeBackoffMs source contract', () => {
  it('uses exponential formula (base * 2^retry)', () => {
    expect(helpersSource).toContain('baseDelayMs * Math.pow(2, retryCount)');
  });

  it('caps at maxDelayMs', () => {
    expect(helpersSource).toContain('Math.min(delay, maxDelayMs)');
  });
});

describe('isTransientError source contract', () => {
  it('checks permanent flag before message matching', () => {
    expect(helpersSource).toContain('.permanent === true');
  });

  it('classifies network errors as transient', () => {
    expect(helpersSource).toContain("'fetch failed'");
    expect(helpersSource).toContain("'network'");
    expect(helpersSource).toContain("'timeout'");
  });

  it('classifies 5xx errors as transient', () => {
    expect(helpersSource).toContain('5\\d{2}');
  });

  it('classifies not_found as permanent', () => {
    expect(helpersSource).toContain("'not found'");
    expect(helpersSource).toContain("'not_found'");
  });
});
