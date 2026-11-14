/**
 * The first-run SETUP_TOKEN is a plain-text Worker var, and `wrangler deploy` prints the value of
 * every plain-text binding into the deploy job's log. On a public repository that log is public,
 * and on 2026-11-12 a token read from it was used to take over production's first-run setup.
 * These tests pin the mask that keeps the value out of that log.
 */
import { describe, expect, it } from 'vitest';

import { generateSetupToken } from '../deploy/setup-token.js';

describe('generateSetupToken', () => {
  it('registers the exact token as a log mask inside GitHub Actions', () => {
    const lines: string[] = [];
    const token = generateSetupToken({ GITHUB_ACTIONS: 'true' }, (line) => lines.push(line));

    expect(token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(lines).toEqual([`::add-mask::${token}\n`]);
  });

  it('prints nothing outside GitHub Actions, where a mask command would expose the token', () => {
    const lines: string[] = [];
    generateSetupToken({}, (line) => lines.push(line));
    generateSetupToken({ GITHUB_ACTIONS: 'false' }, (line) => lines.push(line));

    expect(lines).toEqual([]);
  });

  it('returns a different token on every call', () => {
    const write = () => undefined;
    expect(generateSetupToken({}, write)).not.toBe(generateSetupToken({}, write));
  });
});
