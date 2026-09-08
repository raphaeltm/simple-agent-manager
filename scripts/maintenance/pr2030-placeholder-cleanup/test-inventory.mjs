import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { test } from 'node:test';
import { encryptionKey, inspectInventory, TARGET } from './inventory.mjs';

const token = 'test-only-provider-token-123456789';
const keyBytes = Buffer.alloc(32, 17);
const keyBase64 = keyBytes.toString('base64');
const installation = '0123456789abcdef0123456789abcdef';
const environment = {
  CF_ACCOUNT_ID: TARGET.account,
  CF_API_TOKEN: 'test-cf-secret',
  BASE_DOMAIN: TARGET.domain,
  CREDENTIAL_ENCRYPTION_KEY: keyBase64,
};
async function fixture({
  fingerprintMismatch = false,
  workerMismatch = false,
  pages,
  providerFail = false,
} = {}) {
  const key = await webcrypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt']);
  const iv = Buffer.alloc(12, 3).toString('base64');
  const encrypted_token = Buffer.from(
    await webcrypto.subtle.encrypt(
      { name: 'AES-GCM', iv: Buffer.from(iv, 'base64') },
      key,
      new TextEncoder().encode(token)
    )
  ).toString('base64');
  const fingerprint = `sha256:${createHash('sha256').update(`provider-credential-v1\0${iv}\0${encrypted_token}`).digest('hex')}`;
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, method: init.method });
    assert.equal(init.redirect, 'error');
    if (url.includes('api.cloudflare.com')) {
      assert.equal(init.headers.Authorization, `Bearer ${environment.CF_API_TOKEN}`);
      if (url.endsWith('/settings')) {
        assert.equal(init.method, 'GET');
        return Response.json({
          success: true,
          result: {
            bindings: [
              { name: 'BASE_DOMAIN', text: TARGET.domain },
              { name: 'DATABASE', type: 'd1', id: TARGET.database },
              {
                name: 'VM_AGENT_REQUIRED_VERSION',
                text: workerMismatch ? 'wrong-version' : TARGET.version,
              },
              { name: 'SAM_INSTALLATION_ID', text: installation },
            ],
          },
        });
      }
      const { sql, params } = JSON.parse(init.body);
      assert.ok(sql.startsWith('SELECT '));
      const isCredential = sql.includes('FROM platform_credentials');
      assert.ok(params.includes(isCredential ? TARGET.credential : TARGET.incarnation));
      return Response.json({
        success: true,
        result: [
          {
            success: true,
            results: isCredential
              ? [{ encrypted_token, iv }]
              : [{ fingerprint: fingerprintMismatch ? 'changed' : fingerprint }],
          },
        ],
      });
    }
    assert.ok(url.startsWith('https://api.hetzner.cloud/v1/servers?'));
    assert.equal(init.method, 'GET');
    assert.equal(init.headers.Authorization, `Bearer ${token}`);
    if (providerFail) throw new Error(`untrusted error containing ${token}`);
    const page = Number(new URL(url).searchParams.get('page'));
    return Response.json(
      pages?.(page) ?? { servers: [], meta: { pagination: { next_page: null } } }
    );
  };
  return { fetchImpl, requests, encrypted_token };
}
function server(id, overrides = {}) {
  return {
    id,
    name: `node-${TARGET.node.toLowerCase()}`,
    status: 'running',
    created: '2026-09-08T13:36:11Z',
    public_net: { ipv4: { ip: '203.0.113.1' }, ipv6: { ip: '2001:db8::/64' } },
    labels: {
      node: TARGET.node.toLowerCase(),
      managed: 'simple-agent-manager',
      role: 'workspace',
      env: 'staging',
      installation,
    },
    user_data: token,
    ...overrides,
  };
}
test('decrypts real AES-GCM format, traverses pages, filters exact name or label and omits secrets', async () => {
  const f = await fixture({
    pages: (page) => ({
      servers:
        page === 1
          ? [server(1), server(2, { name: 'unrelated', labels: {} })]
          : [
              server(3, {
                name: 'renamed',
                labels: { node: TARGET.node.toLowerCase(), env: token, arbitrary: token },
              }),
            ],
      meta: { pagination: { next_page: page === 1 ? 2 : null } },
    }),
  });
  const result = await inspectInventory(environment, f);
  assert.deepEqual(
    result.matches.map((match) => match.id),
    ['1', '3']
  );
  assert.equal(result.matches[1].labels.env, '[mismatch]');
  assert.equal(result.absenceProof, false);
  for (const secret of [
    token,
    keyBase64,
    environment.CF_API_TOKEN,
    f.encrypted_token,
    'user_data',
    'arbitrary',
  ]) {
    assert.ok(!JSON.stringify(result).includes(secret));
  }
});
test('empty complete inventory remains an observation without absence proof', async () => {
  assert.deepEqual((await inspectInventory(environment, await fixture())).matches, []);
});
for (const mode of ['workerMismatch', 'fingerprintMismatch'])
  test(`${mode} refuses before provider access`, async () => {
    const f = await fixture({ [mode]: true });
    await assert.rejects(inspectInventory(environment, f));
    assert.ok(f.requests.every(({ url }) => url.includes('api.cloudflare.com')));
  });
test('bad decryption key refuses before provider access', async () => {
  const f = await fixture();
  await assert.rejects(
    inspectInventory(
      { ...environment, CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32).toString('base64') },
      f
    ),
    /decryption unavailable/
  );
  assert.ok(f.requests.every(({ url }) => url.includes('api.cloudflare.com')));
});
test('provider transport errors do not expose untrusted response/secret content', async () => {
  await assert.rejects(inspectInventory(environment, await fixture({ providerFail: true })), {
    message: 'Hetzner request failed',
  });
});
test('bounded inventory refuses incomplete pagination', async () => {
  const f = await fixture({
    pages: (page) => ({ servers: [], meta: { pagination: { next_page: page + 1 } } }),
  });
  await assert.rejects(inspectInventory(environment, f), /page limit reached/);
  assert.equal(f.requests.filter(({ url }) => url.includes('api.hetzner')).length, 10);
});
test('canonical Pulumi fallback captures only encryptionKey and permits no stack mutation/export', () => {
  const calls = [];
  const result = encryptionKey(
    {
      BASE_DOMAIN: TARGET.domain,
      RESOURCE_PREFIX: 'sam',
      AWS_ACCESS_KEY_ID: 'test-access',
      AWS_SECRET_ACCESS_KEY: 'test-secret',
      PULUMI_CONFIG_PASSPHRASE: 'test-pass',
    },
    (command, args, options) => {
      calls.push({ command, args });
      assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe']);
      return args[0] === 'login' ? '' : keyBase64;
    }
  );
  assert.equal(result, keyBase64);
  assert.deepEqual(
    calls.map(({ args }) => args),
    [
      [
        'login',
        `s3://sam-pulumi-state?endpoint=https://${TARGET.account}.r2.cloudflarestorage.com&region=auto`,
      ],
      ['stack', 'output', 'encryptionKey', '--show-secrets', '--stack', 'staging'],
    ]
  );
  assert.equal(
    encryptionKey({ CREDENTIAL_ENCRYPTION_KEY: 'first', ENCRYPTION_KEY: 'second' }),
    'first'
  );
});
