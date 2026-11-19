/** Bounded provider compatibility check; staging only. Restores the original SPF. */
import assert from 'node:assert/strict';

const { CF_API_TOKEN, CF_ZONE_ID, BASE_DOMAIN, DEPLOY_ENVIRONMENT } = process.env;
assert.equal(DEPLOY_ENVIRONMENT, 'staging', 'This audit is staging-only');
assert.ok(CF_API_TOKEN && CF_ZONE_ID && BASE_DOMAIN, 'Missing staging configuration');
const base = `https://api.cloudflare.com/client/v4/zones/${CF_ZONE_ID}`;
async function request(path, method = 'GET', body) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { Authorization: `Bearer ${CF_API_TOKEN}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(30_000),
  });
  const data = await response.json();
  assert.ok(
    response.ok && data.success,
    `Cloudflare ${method} ${path} failed: ${JSON.stringify(data.errors)}`
  );
  return data;
}
async function rootMail() {
  const data = await request(`/dns_records?name=${encodeURIComponent(BASE_DOMAIN)}&per_page=100`);
  assert.ok(data.result_info.total_count <= 100, 'Incomplete DNS listing');
  return data.result.filter(
    (r) => r.type === 'MX' || (r.type === 'TXT' && /^"?v=spf1\s/i.test(r.content))
  );
}
const canonical = (rows) =>
  JSON.stringify(
    rows
      .map(({ type, name, content, priority }) => ({ type, name, content, priority }))
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  );
const zone = await request('');
assert.equal(zone.result.name, BASE_DOMAIN, 'Zone does not match configured staging domain');
const before = await rootMail();
const spf = before.filter((r) => r.type === 'TXT');
assert.equal(spf.length, 1, 'Audit requires exactly one existing staging SPF');
const original = spf[0];
assert.match(
  original.content,
  /^"?v=spf1 include:_spf\.mx\.cloudflare\.net ~all"?$/,
  'Audit only accepts the default staging SPF'
);
const routing = await request('/email/routing');
assert.equal(routing.result.enabled, true, 'Audit requires already-enabled staging routing');
const combined = 'v=spf1 include:_spf.google.com include:_spf.mx.cloudflare.net ~all';
let changed = false;
try {
  // A timeout can follow a successful provider write; always attempt restoration.
  changed = true;
  await request(`/dns_records/${original.id}`, 'PATCH', { content: combined });
  await request('/email/routing/dns', 'POST', { name: `agents.${BASE_DOMAIN}` });
  const after = await rootMail();
  assert.equal(
    canonical(after.filter((r) => r.type === 'MX')),
    canonical(before.filter((r) => r.type === 'MX')),
    'Root MX changed'
  );
  const currentSpf = after.filter((r) => r.type === 'TXT');
  assert.equal(currentSpf.length, 1, 'Provider created duplicate root SPF');
  assert.equal(
    currentSpf[0].content.replace(/^"|"$/g, ''),
    combined,
    'Provider replaced combined SPF'
  );
  console.log(
    'PASS: routing DNS enable preserved combined Google/Cloudflare SPF and root MX on the existing staging zone.'
  );
} finally {
  if (changed) {
    await request(`/dns_records/${original.id}`, 'PATCH', { content: original.content });
    assert.equal(
      canonical(await rootMail()),
      canonical(before),
      'Root mail DNS restoration failed'
    );
    console.log('PASS: original staging root mail DNS restored.');
  }
}
