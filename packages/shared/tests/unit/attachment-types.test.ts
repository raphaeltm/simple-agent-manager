/**
 * Tests for task attachment shared types, constants, and filename regex.
 */
import { describe, expect,it } from 'vitest';

import { ATTACHMENT_DEFAULTS, SAFE_FILENAME_REGEX, TASK_EXECUTION_STEPS } from '../../src/types';

describe('ATTACHMENT_DEFAULTS', () => {
  it('defines expected default values', () => {
    expect(ATTACHMENT_DEFAULTS.UPLOAD_MAX_BYTES).toBe(50 * 1024 * 1024); // 50MB
    expect(ATTACHMENT_DEFAULTS.UPLOAD_BATCH_MAX_BYTES).toBe(200 * 1024 * 1024); // 200MB
    expect(ATTACHMENT_DEFAULTS.MAX_FILES).toBe(20);
    expect(ATTACHMENT_DEFAULTS.PRESIGN_EXPIRY_SECONDS).toBe(900); // 15 min
  });
});

describe('SAFE_FILENAME_REGEX', () => {
  it('allows simple filenames', () => {
    expect(SAFE_FILENAME_REGEX.test('report.pdf')).toBe(true);
    expect(SAFE_FILENAME_REGEX.test('my-file.txt')).toBe(true);
    expect(SAFE_FILENAME_REGEX.test('data_v2.csv')).toBe(true);
  });

  it('allows filenames with spaces', () => {
    expect(SAFE_FILENAME_REGEX.test('my file name.txt')).toBe(true);
  });

  it('allows filenames with multiple dots', () => {
    expect(SAFE_FILENAME_REGEX.test('archive.tar.gz')).toBe(true);
    expect(SAFE_FILENAME_REGEX.test('v1.2.3-release.zip')).toBe(true);
  });

  it('rejects path traversal', () => {
    expect(SAFE_FILENAME_REGEX.test('../etc/passwd')).toBe(false);
    expect(SAFE_FILENAME_REGEX.test('../../secret.txt')).toBe(false);
    expect(SAFE_FILENAME_REGEX.test('dir/file.txt')).toBe(false);
  });

  it('rejects shell metacharacters', () => {
    expect(SAFE_FILENAME_REGEX.test('file;rm -rf.txt')).toBe(false);
    expect(SAFE_FILENAME_REGEX.test('file|cat.txt')).toBe(false);
    expect(SAFE_FILENAME_REGEX.test('file`cmd`.txt')).toBe(false);
    expect(SAFE_FILENAME_REGEX.test('file$(cmd).txt')).toBe(false);
    expect(SAFE_FILENAME_REGEX.test("file'quote.txt")).toBe(false);
    expect(SAFE_FILENAME_REGEX.test('file"quote.txt')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(SAFE_FILENAME_REGEX.test('')).toBe(false);
  });

  it('rejects backslash paths', () => {
    expect(SAFE_FILENAME_REGEX.test('dir\\file.txt')).toBe(false);
  });
});

describe('TASK_EXECUTION_STEPS', () => {
  it('includes attachment_transfer between workspace_ready and agent_session', () => {
    const steps = TASK_EXECUTION_STEPS;
    const wsReadyIdx = steps.indexOf('workspace_ready');
    const attachIdx = steps.indexOf('attachment_transfer');
    const agentIdx = steps.indexOf('agent_session');

    expect(attachIdx).toBeGreaterThan(-1);
    expect(attachIdx).toBeGreaterThan(wsReadyIdx);
    expect(attachIdx).toBeLessThan(agentIdx);
  });
});
