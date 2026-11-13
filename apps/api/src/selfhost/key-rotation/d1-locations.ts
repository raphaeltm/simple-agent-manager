/**
 * Every D1 column pair holding AES-GCM ciphertext under an app key (services/encryption.ts).
 *
 * Enumerated from the schema and the writers, and machine-checked: a test fails when a table
 * gains an `iv` / `*_iv` column that is not listed here or in NOT_ROTATED_IV_COLUMNS
 * (tests/unit/selfhost/key-rotation.test.ts, 'the D1 location registry'). Writers per table: see the inventory in
 * tasks/active/2026-11-13-selfhost-platform-key-rotation.md.
 *
 * Rows hold ciphertext only when the IV is non-empty: `is_secret = 0` runtime values are stored
 * in plaintext with a NULL IV, and capacity-anchor credential rows carry `'' / ''`.
 */
import type { AesKeyRole } from './keys';

export interface CipherPair {
  ciphertext: string;
  iv: string;
}

export interface D1Location {
  /** Stable name used in the journal and in reports. */
  name: string;
  table: string;
  pairs: readonly CipherPair[];
  role: AesKeyRole;
  /**
   * Tables that hold byte-identical copies of this table's (encrypted_token, iv) pairs
   * (credential mirrors: gcp-credential-mirrors.ts, run-agent-credential.ts, composable
   * credential sync). A re-encrypted pair is rewritten in all of them in the same batch, so
   * mirror pairing by equal ciphertext keeps working.
   */
  mirrors?: readonly string[];
  /**
   * The pair is a provider credential whose ciphertext fingerprint pins existing nodes
   * (nodes.placement_credential_fingerprint, provider-credential-exact.ts). The fingerprint is
   * remapped in the same batch: the plaintext is unchanged, so the node still belongs to the
   * same account, and strict teardown keeps working (rules/71).
   */
  nodeFingerprint?: boolean;
}

const TOKEN: CipherPair = { ciphertext: 'encrypted_token', iv: 'iv' };
const VALUE: CipherPair = { ciphertext: 'stored_value', iv: 'value_iv' };
const CONTENT: CipherPair = { ciphertext: 'stored_content', iv: 'content_iv' };

export const D1_LOCATIONS: readonly D1Location[] = [
  {
    name: 'credentials',
    table: 'credentials',
    pairs: [TOKEN],
    role: 'credential',
    mirrors: ['cc_credentials'],
    nodeFingerprint: true,
  },
  {
    name: 'cc_credentials',
    table: 'cc_credentials',
    pairs: [TOKEN],
    role: 'credential',
    mirrors: ['credentials'],
    nodeFingerprint: true,
  },
  {
    name: 'platform_credentials',
    table: 'platform_credentials',
    pairs: [TOKEN],
    role: 'credential',
    nodeFingerprint: true,
  },
  {
    name: 'project_runtime_env_vars',
    table: 'project_runtime_env_vars',
    pairs: [VALUE],
    role: 'credential',
  },
  {
    name: 'project_runtime_files',
    table: 'project_runtime_files',
    pairs: [CONTENT],
    role: 'credential',
  },
  {
    name: 'profile_runtime_env_vars',
    table: 'profile_runtime_env_vars',
    pairs: [VALUE],
    role: 'credential',
  },
  {
    name: 'profile_runtime_files',
    table: 'profile_runtime_files',
    pairs: [CONTENT],
    role: 'credential',
  },
  {
    name: 'skill_runtime_env_vars',
    table: 'skill_runtime_env_vars',
    pairs: [VALUE],
    role: 'credential',
  },
  {
    name: 'skill_runtime_files',
    table: 'skill_runtime_files',
    pairs: [CONTENT],
    role: 'credential',
  },
  {
    name: 'deployment_secrets',
    table: 'deployment_secrets',
    pairs: [{ ciphertext: 'encrypted_value', iv: 'iv' }],
    role: 'credential-nullish',
  },
  {
    name: 'deployment_environment_config_vars',
    table: 'deployment_environment_config_vars',
    pairs: [VALUE],
    role: 'credential',
  },
  {
    name: 'mcp_connections',
    table: 'mcp_connections',
    pairs: [
      { ciphertext: 'encrypted_url', iv: 'url_iv' },
      { ciphertext: 'encrypted_token', iv: 'token_iv' },
      { ciphertext: 'encrypted_headers', iv: 'headers_iv' },
    ],
    role: 'credential',
  },
];

/** `iv` columns that are deliberately not here, with the reason (checked by the same test). */
export const NOT_ROTATED_IV_COLUMNS: Readonly<Record<string, string>> = {};

export function d1Location(name: string): D1Location | undefined {
  return D1_LOCATIONS.find((location) => location.name === name);
}
