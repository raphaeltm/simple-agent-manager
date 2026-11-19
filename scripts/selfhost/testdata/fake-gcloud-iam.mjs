#!/usr/bin/env node
// Fake `gcloud` for gcp-bootstrap.test.ts: the IAM and workload identity commands
// deploy/selfhost/gcp-bootstrap.sh runs. State is one JSON file ($STATE/gcp.json), so a later run
// sees what an earlier one did; every call is appended to $STATE/calls.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const STATE = process.env.STATE;
const args = process.argv.slice(2);
appendFileSync(join(STATE, 'calls'), `${args.join(' ')}\n`);
const file = join(STATE, 'gcp.json');
const db = existsSync(file)
  ? JSON.parse(readFileSync(file, 'utf8'))
  : { pools: {}, providers: {}, accounts: {}, bindings: [] };
const save = () => writeFileSync(file, JSON.stringify(db, null, 2));
const flag = (name) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const words = args.filter((a, i) => !a.startsWith('--') && (args[i - 1] ?? '') !== '--project');
const cmd = words.slice(0, 4).join(' ');
const fail = (message) => {
  process.stderr.write(`ERROR: ${message}\n`);
  process.exit(1);
};
const out = (text) => process.stdout.write(`${text}\n`);
// FAKE_GCLOUD_FAIL_ONCE=<command prefix>: the first matching call fails, as a new service
// account's first IAM binding does on real GCP while it propagates.
const failOnce = process.env.FAKE_GCLOUD_FAIL_ONCE;
if (failOnce && cmd.startsWith(failOnce) && !existsSync(join(STATE, 'failed-once'))) {
  writeFileSync(join(STATE, 'failed-once'), cmd);
  fail('Service account does not exist (propagating)');
}
const format = flag('format') ?? '';

if (cmd.startsWith('projects describe')) out('123456789012');
else if (cmd.startsWith('services enable')) save();
else if (cmd.startsWith('iam workload-identity-pools providers')) {
  const [, , , op, id] = words;
  const pool = flag('workload-identity-pool');
  if (op === 'list') {
    // value(name,oidc.issuerUri): the full resource name, a tab, the issuer.
    for (const [providerId, provider] of Object.entries(db.providers)) {
      if (provider.pool !== pool) continue;
      const name = `projects/123456789012/locations/global/workloadIdentityPools/${pool}/providers/${providerId}`;
      out(`${name}\t${provider.issuer ?? ''}`);
    }
  } else if (op === 'describe') {
    if (!db.providers[id]) fail('not found');
    if (format.includes('issuerUri')) out(db.providers[id].issuer);
    if (format.includes('state')) out(db.providers[id].state ?? 'ACTIVE');
    if (format.includes('attributeCondition')) out(db.providers[id].condition ?? '');
    if (format.includes('disabled')) out(db.providers[id].disabled ? 'True' : 'False');
    if (format.includes('allowedAudiences')) out(db.providers[id].audience ?? '');
  } else if (op === 'create-oidc') {
    db.providers[id] = {
      issuer: flag('issuer-uri'),
      pool,
      condition: flag('attribute-condition'),
      audience: flag('allowed-audiences'),
    };
    save();
  } else if (op === 'update-oidc') {
    if (!db.providers[id]) fail('not found');
    db.providers[id].condition = flag('attribute-condition');
    db.providers[id].audience = flag('allowed-audiences');
    save();
  } else fail(`unexpected ${cmd}`);
} else if (cmd.startsWith('iam workload-identity-pools')) {
  const [, , op, id] = words;
  if (op === 'describe') {
    // A deleted pool still describes, with state DELETED, for 30 days (as Google keeps it).
    if (!db.pools[id]) fail('not found');
    if (format.includes('state')) out(db.pools[id].state ?? 'ACTIVE');
    if (format.includes('disabled')) out(db.pools[id].disabled ? 'True' : 'False');
  } else if (op === 'create') {
    db.pools[id] = { description: flag('description') };
    save();
  } else fail(`unexpected ${cmd}`);
} else if (cmd.startsWith('iam service-accounts add-iam-policy-binding')) save();
else if (cmd.startsWith('iam service-accounts')) {
  const [, , op, id] = words;
  const email = id.includes('@') ? id : `${id}@${flag('project')}.iam.gserviceaccount.com`;
  if (op === 'describe') {
    if (!db.accounts[email]) fail('not found');
    if (format.includes('disabled')) out(db.accounts[email].disabled ? 'True' : 'False');
  } else if (op === 'create') {
    db.accounts[email] = { description: flag('description') };
    save();
  } else fail(`unexpected ${cmd}`);
} else if (cmd.startsWith('projects add-iam-policy-binding')) {
  const entry = `project:${words[2]} ${flag('role')} ${flag('member')}`;
  if (!db.bindings.includes(entry)) db.bindings.push(entry);
  save();
} else fail(`fake gcloud: unexpected: ${args.join(' ')}`);
