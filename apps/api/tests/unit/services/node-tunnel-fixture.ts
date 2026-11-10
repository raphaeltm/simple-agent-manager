/**
 * Vertical slice for managed-node Cloudflare Tunnel provisioning and deletion.
 *
 * Real code under test: provisionNode, the tunnel journal (shipped migration 0230 applied to a
 * real SQLite engine), the Cloudflare tunnel client, strict node deletion and the cron sweep.
 * Mocked only at true boundaries: the cloud provider (createVM/deleteVM), callback JWT signing,
 * allocation-authority validation, the legacy A-record DNS helpers, cloud-init rendering (to
 * capture the variables) and node log capture. Cloudflare is a stateful fake reached through
 * the real global fetch path (tests/helpers/fake-cloudflare-tunnels.ts).
 */
import Database from 'better-sqlite3';
import { afterEach, beforeEach, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { createNodeRecord } from '../../../src/services/nodes';
import { FakeCloudflare } from '../../helpers/fake-cloudflare-tunnels';
import {
  applySqliteMigration,
  createAllSchemaTables,
  createMemoryKv,
  createSqliteD1,
} from '../../helpers/sqlite-d1';

const mocks = vi.hoisted(() => ({
  assertPlan: vi.fn(),
  createProvider: vi.fn(),
  createVM: vi.fn(),
  deleteVM: vi.fn(),
  cloudInitVars: [] as Array<Record<string, unknown>>,
  createARecord: vi.fn(),
  deleteDnsRecord: vi.fn(),
  destroyContainer: vi.fn(),
  signCallbackToken: vi.fn(),
}));
vi.mock('../../../src/services/node-allocation-validation', () => ({
  assertNodeAllocationPlanCurrent: mocks.assertPlan,
}));
vi.mock('../../../src/services/provider-credentials', () => ({
  createProviderForUser: mocks.createProvider,
  exactProviderCredentialBindingFromPlacementSnapshot: () => ({
    credentialSource: 'user',
    credentialReference: 'cred-1',
    credentialVersion: 1,
  }),
}));
vi.mock('../../../src/services/jwt', () => ({
  signNodeCallbackToken: async () => 'callback-token',
  signCurrentNodeCallbackToken: mocks.signCallbackToken,
}));
vi.mock('../../../src/lib/secrets', () => ({ getCredentialEncryptionKey: () => 'test-key' }));
vi.mock('../../../src/services/observability', () => ({ persistError: vi.fn() }));
vi.mock('@simple-agent-manager/cloud-init', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@simple-agent-manager/cloud-init')>()),
  generateCloudInit: (vars: Record<string, unknown>) => {
    mocks.cloudInitVars.push(vars);
    return 'cloud-init';
  },
  validateCloudInitSize: () => true,
}));
vi.mock('../../../src/services/dns', () => ({
  createNodeBackendDNSRecord: mocks.createARecord,
  deleteDNSRecord: mocks.deleteDnsRecord,
}));
vi.mock('../../../src/services/node-log-capture', () => ({
  captureNodeLogsBeforeTeardown: async () => null,
}));
vi.mock('../../../src/services/vm-agent-container', () => ({
  destroyVmAgentContainer: mocks.destroyContainer,
}));

const ACCOUNT = 'acct-staging';
const ZONE = 'zone-staging';
const USER = 'user-1';
const MIGRATION = new URL(
  '../../../src/db/migrations/0230_node_cloudflare_tunnels.sql',
  import.meta.url
);

let sqlite: Database.Database;
let env: Env & Record<string, string | undefined>;
let cf: FakeCloudflare;
let vmCounter = 0;
const originalFetch = globalThis.fetch;
const provider = {
  provider: { createVM: mocks.createVM, deleteVM: mocks.deleteVM },
  providerName: 'hetzner',
  credentialSource: 'user',
};

function tunnelEnv(overrides: Record<string, string | undefined> = {}) {
  return {
    DATABASE: createSqliteD1(sqlite),
    KV: createMemoryKv(),
    BASE_DOMAIN: 'example.test',
    ENVIRONMENT: 'test',
    SAM_INSTALLATION_ID: '0123456789abcdef0123456789abcdef',
    CF_API_TOKEN: 'account-api-token-NEVER-ON-NODE',
    CF_ACCOUNT_ID: ACCOUNT,
    CF_ZONE_ID: ZONE,
    VM_AGENT_TRANSPORT: 'cloudflare-tunnel',
    CLOUDFLARED_VERSION: '2026.10.7',
    ...overrides,
  } as unknown as Env & Record<string, string | undefined>;
}

async function freshNode(overrides: { nodeRole?: 'workspace' | 'deployment' } = {}) {
  return createNodeRecord(env, {
    userId: USER,
    name: 'Tunnel node',
    vmSize: 'medium',
    vmLocation: 'nbg1',
    heartbeatStaleAfterSeconds: 180,
    cloudProvider: 'hetzner',
    runtime: 'vm',
    providerInstanceType: 'cx33',
    ...overrides,
  });
}

interface NodeView {
  status: string;
  transport: string | null;
  tunnelId: string | null;
  tunnelName: string | null;
  backendDnsRecordId: string | null;
  ipAddress: string | null;
  providerInstanceId: string | null;
  incarnation: string | null;
  proof: string | null;
}
function readNode(id: string): NodeView | undefined {
  return sqlite
    .prepare(
      `SELECT status, transport, tunnel_id AS tunnelId, tunnel_name AS tunnelName,
        backend_dns_record_id AS backendDnsRecordId, ip_address AS ipAddress,
        provider_instance_id AS providerInstanceId, runtime_incarnation_id AS incarnation,
        runtime_termination_confirmed_at AS proof
       FROM nodes WHERE id = ?`
    )
    .get(id) as NodeView | undefined;
}

interface JournalView {
  id: string;
  runtimeIncarnationId: string;
  tunnelId: string | null;
  tunnelName: string;
  dnsRecordId: string | null;
  status: string;
  cleanupReason: string | null;
  cleanupAttempts: number;
  cleanupNextAttemptAt: string | null;
  lastError: string | null;
  pendingCreateCount: number;
}
function journal(nodeId: string): JournalView[] {
  return sqlite
    .prepare(
      `SELECT id, runtime_incarnation_id AS runtimeIncarnationId, tunnel_id AS tunnelId,
        tunnel_name AS tunnelName, dns_record_id AS dnsRecordId, status,
        cleanup_reason AS cleanupReason, cleanup_attempts AS cleanupAttempts,
        cleanup_next_attempt_at AS cleanupNextAttemptAt, last_error AS lastError,
        pending_create_count AS pendingCreateCount
       FROM node_cloudflare_tunnels WHERE node_id = ? ORDER BY created_at, id`
    )
    .all(nodeId) as JournalView[];
}

function vmFor(): { id: string; ip: string } & Record<string, unknown> {
  vmCounter++;
  return {
    id: `vm-${vmCounter}`,
    ip: `203.0.113.${vmCounter}`,
    name: 'node',
    status: 'running',
    serverType: 'cx33',
    location: 'nbg1',
    createdAt: new Date().toISOString(),
    labels: {},
    observedHardware: {
      serverType: { source: 'observed' as const, value: 'cx33' },
      resources: {
        source: 'observed' as const,
        value: { vcpuCount: 4, memoryMb: 8192, diskGb: 80 },
      },
    },
  };
}

/** Every text value stored anywhere in D1, to prove a secret was never persisted. */
function allStoredText(): string {
  const tables = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all() as Array<{ name: string }>;
  return tables
    .map(({ name }) => JSON.stringify(sqlite.prepare(`SELECT * FROM "${name}"`).all()))
    .join('\n');
}

let logged: string[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.cloudInitVars.length = 0;
  vmCounter = 0;
  logged = [];
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logged.push(
        args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' ')
      );
    });
  }
  mocks.assertPlan.mockResolvedValue(undefined);
  mocks.signCallbackToken.mockResolvedValue('callback-token');
  mocks.createProvider.mockResolvedValue(provider);
  mocks.createVM.mockImplementation(async () => vmFor());
  mocks.deleteVM.mockResolvedValue(undefined);
  mocks.createARecord.mockResolvedValue('a-record-1');
  mocks.deleteDnsRecord.mockResolvedValue(undefined);
  sqlite = new Database(':memory:');
  createAllSchemaTables(sqlite, schema);
  applySqliteMigration(
    sqlite,
    new URL('../../../src/db/migrations/0196_admin_settings.sql', import.meta.url)
  );
  // Exercise the shipped DDL (CHECK + unique indexes), not the schema-derived approximation.
  sqlite.exec('DROP TABLE node_cloudflare_tunnels');
  applySqliteMigration(sqlite, MIGRATION);
  applySqliteMigration(
    sqlite,
    new URL('../../../src/db/migrations/0231_node_tunnel_pending_creates.sql', import.meta.url)
  );
  applySqliteMigration(
    sqlite,
    new URL('../../../src/db/migrations/0233_node_tunnel_pending_create_last_at.sql', import.meta.url)
  );
  env = tunnelEnv();
  cf = new FakeCloudflare(ACCOUNT, ZONE);
  globalThis.fetch = cf.fetch as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
  sqlite.close();
});

export function setEnv(value: typeof env): void {
  env = value;
}
export {
  ACCOUNT,
  allStoredText,
  cf,
  env,
  freshNode,
  journal,
  logged,
  mocks,
  provider,
  readNode,
  sqlite,
  tunnelEnv,
  USER,
  vmFor,
  ZONE,
};
