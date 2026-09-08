import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { adoptHelper, buildAdoptionUpdate, verifyServer } from './adopt-helper.mjs';
import { TARGET } from './inventory.mjs';
const now = Date.parse('2026-09-08T13:56:25Z');
const fingerprint = 'sha256:test-fixture-only';
const credential = { encrypted_token: 'test-only-cipher', iv: 'test-only-iv' };
function rawServer() {
  return {
    id: Number(TARGET.providerId),
    status: 'running',
    created: TARGET.providerCreatedAt,
    public_net: { ipv4: { ip: TARGET.ipv4 }, ipv6: { ip: TARGET.ipv6 } },
    server_type: { name: 'cx23', cores: 2, memory: 4, disk: 40 },
    datacenter: { location: { name: 'nbg1' } },
    labels: {
      node: TARGET.node.toLowerCase(),
      managed: 'simple-agent-manager',
      role: 'workspace',
      env: 'staging',
      installation: TARGET.installation,
    },
  };
}
function row() {
  return {
    id: TARGET.node,
    user_id: TARGET.user,
    runtime_incarnation_id: TARGET.incarnation,
    created_at: TARGET.createdAt,
    runtime: 'vm',
    node_class: 'managed',
    node_role: 'workspace',
    status: 'running',
    cloud_provider: 'hetzner',
    provider_instance_type: 'cx23',
    vm_location: 'nbg1',
    credential_source: 'platform',
    placement_credential_source: 'platform',
    placement_credential_reference: `platform_credentials:${TARGET.credential}`,
    placement_credential_fingerprint: fingerprint,
    runtime_termination_confirmed_at: null,
    provider_instance_id: null,
    ip_address: TARGET.agentIpv6,
    last_heartbeat_at: '2026-09-08T13:56:21.099Z',
    updated_at: '2026-09-08T13:56:21.099Z',
    observed_provider_instance_type: null,
    observed_provider_instance_vcpu_count: null,
    observed_provider_instance_memory_mb: null,
    observed_provider_instance_disk_gb: null,
    observed_hardware_json: null,
    observed_hardware_source: null,
    capacity_pool_id: 'unchanged-pool',
    capacity_pool_revision: 21,
    provider_instance_price_hourly_micros: 4800,
    provider_instance_vcpu_count: 2,
    provider_instance_memory_mb: 4096,
    provider_instance_disk_gb: 40,
    error_message: 'Keep diagnostic until normal heartbeat succeeds',
    backend_dns_record_id: null,
  };
}
function fixture() {
  const db = new DatabaseSync(':memory:');
  const before = row();
  db.exec(`CREATE TABLE nodes (${Object.entries(before)
    .map(
      ([key, value]) =>
        `${key} ${key === 'id' ? 'TEXT PRIMARY KEY' : typeof value === 'number' ? 'INTEGER' : ''}`
    )
    .join(', ')});
    CREATE TABLE platform_credentials (id TEXT PRIMARY KEY, provider TEXT, credential_type TEXT, is_enabled INTEGER, encrypted_token TEXT, iv TEXT);
    CREATE TABLE workspaces (id TEXT PRIMARY KEY, user_id TEXT, project_id TEXT, status TEXT, node_id TEXT);`);
  const insert = db.prepare(
    `INSERT INTO nodes (${Object.keys(before).join(',')}) VALUES (${Object.keys(before)
      .map(() => '?')
      .join(',')})`
  );
  insert.run(...Object.values(before));
  insert.run(
    ...Object.values({ ...before, id: 'unrelated-node', provider_instance_id: 'other-server' })
  );
  db.prepare('INSERT INTO platform_credentials VALUES (?, ?, ?, ?, ?, ?)').run(
    TARGET.credential,
    'hetzner',
    'cloud-provider',
    1,
    credential.encrypted_token,
    credential.iv
  );
  db.prepare('INSERT INTO workspaces VALUES (?, ?, ?, ?, ?)').run(
    TARGET.workspace,
    TARGET.user,
    TARGET.project,
    'creating',
    null
  );
  const unrelated = { ...db.prepare("SELECT * FROM nodes WHERE id='unrelated-node'").get() };
  const workspace = { ...db.prepare('SELECT * FROM workspaces').get() };
  let writes = 0;
  let beforeWrite = () => {};
  let serverReads = 0;
  const context = {
    installation: TARGET.installation,
    fingerprint,
    credentialSnapshot: credential,
    verifyWorker: async () => TARGET.installation,
    readProviderServer: async () => {
      serverReads++;
      return { server: rawServer() };
    },
    query: async (sql, params) =>
      db
        .prepare(sql)
        .all(...params)
        .map((value) => ({ ...value })),
    cf: async (_path, { sql, params }) => {
      beforeWrite();
      writes++;
      const result = db.prepare(sql).run(...params);
      return [{ success: true, meta: { changes: result.changes } }];
    },
  };
  const run = (apply = false) =>
    adoptHelper(
      { APPLY_REPAIR: String(apply) },
      { contextFactory: async () => context, now: () => now }
    );
  return {
    db,
    before,
    context,
    run,
    get writes() {
      return writes;
    },
    get serverReads() {
      return serverReads;
    },
    race: (fn) => {
      beforeWrite = fn;
    },
    checkUnrelated: () => {
      assert.deepEqual(
        { ...db.prepare("SELECT * FROM nodes WHERE id='unrelated-node'").get() },
        unrelated
      );
      assert.deepEqual({ ...db.prepare('SELECT * FROM workspaces').get() }, workspace);
    },
  };
}
test('preview performs no writes; apply changes only exact provider/IP/observed fields; retry is idempotent', async () => {
  const f = fixture();
  try {
    assert.equal((await f.run()).outcome, 'preview_eligible');
    assert.equal(f.writes, 0);
    const expected = buildAdoptionUpdate(
      f.before,
      verifyServer(rawServer()),
      credential,
      fingerprint,
      now
    ).expected;
    const audit = await f.run(true);
    assert.equal(audit.changes, 1);
    assert.equal(audit.outcome, 'metadata_adopted');
    assert.deepEqual(
      { ...f.db.prepare('SELECT * FROM nodes WHERE id=?').get(TARGET.node) },
      expected
    );
    assert.equal((await f.run(true)).outcome, 'already_adopted');
    assert.equal(f.writes, 1);
    assert.ok(f.serverReads >= 4);
    f.checkUnrelated();
    assert.ok(!JSON.stringify(audit).includes(credential.encrypted_token));
  } finally {
    f.db.close();
  }
});
for (const [name, sql] of [
  ['incarnation replacement', "UPDATE nodes SET runtime_incarnation_id='replacement' WHERE id=?"],
  ['provider identity filled', "UPDATE nodes SET provider_instance_id='other-server' WHERE id=?"],
  ['heartbeat advanced', "UPDATE nodes SET last_heartbeat_at='2026-09-08T13:56:24Z' WHERE id=?"],
  ['price changed', 'UPDATE nodes SET provider_instance_price_hourly_micros=999 WHERE id=?'],
  ['termination proof', "UPDATE nodes SET runtime_termination_confirmed_at='confirmed' WHERE id=?"],
])
  test(`atomic CAS preserves concurrent ${name}`, async () => {
    const f = fixture();
    try {
      f.race(() => f.db.prepare(sql).run(TARGET.node));
      await assert.rejects(f.run(true), /CAS did not update/);
      const current = f.db.prepare('SELECT * FROM nodes WHERE id=?').get(TARGET.node);
      assert.equal(current.observed_hardware_source, null);
      assert.equal(current.ip_address, TARGET.agentIpv6);
      f.checkUnrelated();
    } finally {
      f.db.close();
    }
  });
test('credential rotation and workspace ownership changes fence the final update', async () => {
  for (const sql of [
    "UPDATE platform_credentials SET encrypted_token='rotated'",
    "UPDATE workspaces SET user_id='new-owner'",
  ]) {
    const f = fixture();
    try {
      f.race(() => f.db.exec(sql));
      await assert.rejects(f.run(true), /CAS did not update/);
      assert.equal(
        f.db.prepare('SELECT provider_instance_id AS id FROM nodes WHERE id=?').get(TARGET.node).id,
        null
      );
    } finally {
      f.db.close();
    }
  }
});
test('provider ownership/creation/type/region/IP mismatches refuse before any UPDATE', async () => {
  const mutations = [
    (s) => {
      s.labels.installation = 'wrong';
    },
    (s) => {
      s.labels.node = 'wrong';
    },
    (s) => {
      s.created = '2026-09-08T12:00:00Z';
    },
    (s) => {
      s.server_type.name = 'cx33';
    },
    (s) => {
      s.datacenter.location.name = 'fsn1';
    },
    (s) => {
      s.public_net.ipv4.ip = '203.0.113.5';
    },
  ];
  for (const mutate of mutations) {
    const f = fixture();
    try {
      const server = rawServer();
      mutate(server);
      f.context.readProviderServer = async () => ({ server });
      await assert.rejects(f.run(true));
      assert.equal(f.writes, 0);
      f.checkUnrelated();
    } finally {
      f.db.close();
    }
  }
});
test('stale heartbeat and conflicting existing metadata refuse without writes', async () => {
  for (const sql of [
    "UPDATE nodes SET last_heartbeat_at='2026-09-08T12:00:00Z' WHERE id=?",
    `UPDATE nodes SET provider_instance_id='${TARGET.providerId}' WHERE id=?`,
  ]) {
    const f = fixture();
    try {
      f.db.prepare(sql).run(TARGET.node);
      await assert.rejects(f.run(true));
      assert.equal(f.writes, 0);
    } finally {
      f.db.close();
    }
  }
});
test('provider or Worker changes after preview prevent the atomic write', async () => {
  for (const boundary of ['provider', 'worker']) {
    const f = fixture();
    try {
      if (boundary === 'worker') f.context.verifyWorker = async () => 'changed-installation';
      else {
        let reads = 0;
        f.context.readProviderServer = async () => {
          const server = rawServer();
          if (++reads > 1) server.labels.env = 'production';
          return { server };
        };
      }
      await assert.rejects(f.run(true));
      assert.equal(f.writes, 0);
      f.checkUnrelated();
    } finally {
      f.db.close();
    }
  }
});
