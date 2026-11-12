#!/usr/bin/env node
// Fake `gcloud` for gcp-bootstrap.test.ts: the IAM, workload identity, Compute and Cloud KMS
// commands deploy/selfhost/gcp-bootstrap.sh and gcp-teardown.sh run. State is one JSON file
// ($STATE/gcp.json), so a later run sees what an earlier one did; every call is appended to
// $STATE/calls. Cloud KMS follows the documented rules: a version is deleted only once DESTROYED,
// a key only with no versions left, a ring only with no keys left.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const STATE = process.env.STATE;
const args = process.argv.slice(2);
appendFileSync(join(STATE, 'calls'), `${args.join(' ')}\n`);
const file = join(STATE, 'gcp.json');
const db = existsSync(file)
  ? JSON.parse(readFileSync(file, 'utf8'))
  : { pools: {}, providers: {}, accounts: {}, bindings: [], rings: {}, keys: {} };
// Compute and Cloud Storage for teardown.test.ts: instances, disks, firewall rules, objects.
db.instances ??= [];
db.disks ??= {};
db.firewalls ??= {};
db.objects ??= {};
const save = () => writeFileSync(file, JSON.stringify(db, null, 2));
const flag = (name) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const words = args.filter(
  (a, i) =>
    !a.startsWith('--') && !(args[i - 1] ?? '').match(/^--(key|keyring|location|project|zone)$/)
);
const cmd = words.slice(0, 4).join(' ');
const fail = (message) => {
  process.stderr.write(`ERROR: ${message}\n`);
  process.exit(1);
};
const out = (text) => process.stdout.write(`${text}\n`);
const format = flag('format') ?? '';
// $STATE/fail-once holds one operation that fails the first time it is attempted (resume tests).
function failOnce(operation) {
  const marker = join(STATE, 'fail-once');
  if (existsSync(marker) && readFileSync(marker, 'utf8').trim() === operation) {
    writeFileSync(marker, '');
    fail(`injected failure: ${operation}`);
  }
}
const keyPath = (key) => `${flag('keyring')}/${key ?? flag('key')}`;

function binding(add) {
  const resource = cmd.startsWith('kms keys') ? `key:${keyPath(words[3])}` : `project:${words[2]}`;
  const entry = `${resource} ${flag('role')} ${flag('member')}`;
  if (add) {
    if (!db.bindings.includes(entry)) db.bindings.push(entry);
  } else {
    if (!db.bindings.includes(entry)) fail(`policy has no binding ${entry}`);
    db.bindings = db.bindings.filter((b) => b !== entry);
  }
  save();
}

if (cmd.startsWith('projects describe')) out('123456789012');
else if (cmd.startsWith('services enable')) save();
else if (cmd.startsWith('iam workload-identity-pools providers')) {
  const [, , , op, id] = words;
  if (op === 'describe') {
    if (!db.providers[id]) fail('not found');
    if (format.includes('issuerUri')) out(db.providers[id].issuer);
  } else if (op === 'create-oidc') {
    db.providers[id] = { issuer: flag('issuer-uri') };
    save();
  } else if (op === 'delete') {
    delete db.providers[id];
    save();
  } else fail(`unexpected ${cmd}`);
} else if (cmd.startsWith('iam workload-identity-pools')) {
  const [, , op, id] = words;
  if (op === 'describe') {
    if (!db.pools[id]) fail('not found');
    if (format.includes('description')) out(db.pools[id].description);
  } else if (op === 'create') {
    db.pools[id] = { description: flag('description') };
    save();
  } else if (op === 'delete') {
    delete db.pools[id];
    save();
  } else fail(`unexpected ${cmd}`);
} else if (cmd.startsWith('iam service-accounts add-iam-policy-binding')) save();
else if (cmd.startsWith('iam service-accounts')) {
  const [, , op, id] = words;
  const email = id.includes('@') ? id : `${id}@${flag('project')}.iam.gserviceaccount.com`;
  if (op === 'describe') {
    if (!db.accounts[email]) fail('not found');
    if (format.includes('description')) out(db.accounts[email].description);
  } else if (op === 'create') {
    db.accounts[email] = { description: flag('description') };
    save();
  } else if (op === 'delete') {
    delete db.accounts[email];
    save();
  } else fail(`unexpected ${cmd}`);
} else if (cmd.startsWith('projects add-iam-policy-binding')) binding(true);
else if (cmd.startsWith('projects remove-iam-policy-binding')) binding(false);
else if (cmd.startsWith('compute instances list')) {
  out(JSON.stringify(db.instances.filter((i) => i.labels?.managed === 'simple-agent-manager')));
} else if (cmd.startsWith('compute instances describe') && format === 'json') {
  const hit = db.instances.find((i) => i.name === words[3] && i.zone.endsWith(`/${flag('zone')}`));
  if (!hit) fail(`The resource '${words[3]}' was not found`);
  out(JSON.stringify(hit));
} else if (cmd.startsWith('compute instances delete')) {
  failOnce(`instances delete ${words[3]}`);
  const hit = db.instances.find((i) => i.name === words[3]);
  if (!hit) fail(`The resource '${words[3]}' was not found`);
  for (const d of hit.disks ?? []) if (d.autoDelete) delete db.disks[d.source.split('/').pop()];
  for (const d of hit.disks ?? []) {
    const disk = db.disks[d.source.split('/').pop()];
    if (disk) disk.users = [];
  }
  db.instances = db.instances.filter((i) => i !== hit);
  save();
} else if (cmd.startsWith('compute disks describe')) {
  const disk = db.disks[words[3]];
  if (!disk) fail('not found');
  out((disk.users ?? []).join(';'));
} else if (cmd.startsWith('compute disks delete')) {
  if (!db.disks[words[3]]) fail('not found');
  delete db.disks[words[3]];
  save();
} else if (cmd.startsWith('compute firewall-rules describe')) {
  if (!db.firewalls[words[3]]) fail('not found');
  out(words[3]);
} else if (cmd.startsWith('compute firewall-rules delete')) {
  delete db.firewalls[words[3]];
  save();
} else if (cmd.startsWith('storage ls')) {
  const prefix = (args.find((a) => a.startsWith('gs://')) ?? '').replace(/\*\*$/, '');
  const hits = Object.keys(db.objects).filter((k) => k.startsWith(prefix));
  if (hits.length === 0) fail('(gcloud.storage.ls) One or more URLs matched no objects.');
  for (const k of hits) out(`${String(db.objects[k]).padStart(10)}  2026-11-12T00:00:00Z  ${k}`);
} else if (cmd.startsWith('storage rm')) {
  failOnce('storage rm');
  for (const url of args.filter((a) => a.startsWith('gs://'))) delete db.objects[url];
  save();
} else if (cmd.startsWith('compute instances describe')) {
  if (format.includes('email')) out(process.env.FAKE_BOX_SA ?? '');
  else out(process.env.FAKE_BOX_SCOPES ?? 'https://www.googleapis.com/auth/cloud-platform');
} else if (cmd.startsWith('kms keyrings')) {
  const [, , op, ring] = words;
  if (op === 'describe') {
    if (!db.rings[ring]) fail('not found');
  } else if (op === 'create') {
    db.rings[ring] = {};
    save();
  } else if (op === 'delete') {
    if (Object.keys(db.keys).some((k) => k.startsWith(`${ring}/`))) fail('key ring is not empty');
    delete db.rings[ring];
    save();
  } else fail(`unexpected ${cmd}`);
} else if (cmd.startsWith('kms keys versions')) {
  const [, , , op, version] = words;
  const key = db.keys[keyPath()];
  if (!key) fail('key not found');
  if (op === 'list') {
    for (const [n, state] of Object.entries(key.versions)) {
      out(`projects/p/locations/l/keyRings/r/cryptoKeys/k/cryptoKeyVersions/${n}\t${state}`);
    }
  } else if (op === 'destroy') {
    key.versions[version] = 'DESTROY_SCHEDULED';
    save();
  } else if (op === 'delete') {
    if (key.versions[version] !== 'DESTROYED')
      fail(`version ${version} is ${key.versions[version]}`);
    delete key.versions[version];
    save();
  } else fail(`unexpected ${cmd}`);
} else if (cmd.startsWith('kms keys add-iam-policy-binding')) binding(true);
else if (cmd.startsWith('kms keys remove-iam-policy-binding')) binding(false);
else if (cmd.startsWith('kms keys list')) {
  for (const k of Object.keys(db.keys)) if (k.startsWith(`${flag('keyring')}/`)) out(k);
} else if (cmd.startsWith('kms keys')) {
  const [, , op, id] = words;
  const path = keyPath(id);
  if (op === 'describe') {
    if (!db.keys[path]) fail('not found');
    if (format.includes('labels.sam-install')) out(db.keys[path].labels['sam-install'] ?? '');
  } else if (op === 'create') {
    const labels = Object.fromEntries(
      (flag('labels') ?? '')
        .split(',')
        .filter(Boolean)
        .map((p) => p.split('='))
    );
    db.keys[path] = { labels, versions: { 1: 'ENABLED' } };
    save();
  } else if (op === 'delete') {
    if (Object.keys(db.keys[path]?.versions ?? {}).length > 0) fail('key has versions');
    delete db.keys[path];
    save();
  } else fail(`unexpected ${cmd}`);
} else fail(`fake gcloud: unexpected: ${args.join(' ')}`);
