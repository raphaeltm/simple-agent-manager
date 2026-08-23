/**
 * TypeScript half of the cross-language MCP server name contract.
 *
 * The Go half is packages/vm-agent/internal/acp/mcp_server_name_contract_test.go and reads the
 * same fixture. The rule is implemented independently in both languages, so without a shared
 * corpus they would drift silently — and a drift means the control plane accepts a name the
 * vm-agent then refuses to use, so the user's server is renamed to `sam-mcp-<i>` with no error
 * anywhere.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { MCP_CONNECTION_NAME_PATTERN } from '../../src/types/mcp-connection';

interface Contract {
  valid: string[];
  invalid: string[];
  normalized: Record<string, string>;
}

const contract = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../src/fixtures/mcp-server-name-contract.json', import.meta.url)),
    'utf8'
  )
) as Contract;

/** Mirrors the control-plane normalization in services/mcp-connections.ts. */
function normalize(raw: string): string {
  return raw.trim().toLowerCase();
}

describe('MCP server name contract (TypeScript side)', () => {
  it('accepts every name the contract marks valid', () => {
    for (const name of contract.valid) {
      expect(MCP_CONNECTION_NAME_PATTERN.test(normalize(name)), `expected ${JSON.stringify(name)} to be valid`).toBe(true);
    }
  });

  it('rejects every name the contract marks invalid', () => {
    for (const name of contract.invalid) {
      expect(MCP_CONNECTION_NAME_PATTERN.test(normalize(name)), `expected ${JSON.stringify(name)} to be invalid`).toBe(false);
    }
  });

  it('normalizes case and surrounding whitespace to the contract value', () => {
    for (const [input, expected] of Object.entries(contract.normalized)) {
      expect(normalize(input)).toBe(expected);
      expect(MCP_CONNECTION_NAME_PATTERN.test(normalize(input))).toBe(true);
    }
  });

  it('has a non-trivial corpus, so a broken fixture read cannot pass as all-clear', () => {
    expect(contract.valid.length).toBeGreaterThanOrEqual(8);
    expect(contract.invalid.length).toBeGreaterThanOrEqual(15);
  });
});
