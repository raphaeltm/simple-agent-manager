// Run only on the existing GitHub environment runner. Never emit Pulumi output,
// resource IDs, URNs, config values, diagnostics, or old/new property values.
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';

import { resolveResourceNames } from './workflow-resource-names.mjs';

const keyType = 'random:index/randomId:RandomId';
const keyNames = [
  'encryption-key',
  'trial-claim-token-secret',
  'deploy-signing-private-key',
  'preview-signing-key',
];
const secretOutputs = ['b64Std', 'b64Url', 'dec', 'hex'];
const allowedTypes = new Set([keyType, 'pulumi:pulumi:Stack', 'pulumi:providers:random']);
const allowedOps = new Set([
  'same',
  'update',
  'create',
  'delete',
  'replace',
  'create-replacement',
  'delete-replaced',
  'read',
  'read-replacement',
  'refresh',
  'discard',
  'discard-replaced',
  'remove-pending-replace',
  'import',
  'import-replacement',
]);

function secretDeclared(state, key) {
  return (
    Array.isArray(state?.additionalSecretOutputs) && state.additionalSecretOutputs.includes(key)
  );
}

function hasMutation(step) {
  return (
    step.op !== 'same' ||
    Boolean(step.replaceReasons?.length) ||
    Boolean(step.diffReasons?.length) ||
    Object.keys(step.detailedDiff ?? {}).length > 0
  );
}

function validSummary(summary) {
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)) return false;
  if (!Number.isSafeInteger(summary.same) || summary.same < keyNames.length) return false;
  return Object.entries(summary).every(
    ([op, count]) =>
      allowedOps.has(op) &&
      Number.isSafeInteger(count) &&
      count >= 0 &&
      (op === 'same' || count === 0)
  );
}

function identityPreserved(step) {
  const old = step.oldState;
  const next = step.newState;
  const oldIdPresent = typeof old?.id === 'string' && old.id.length > 0;
  const newIdUnknown = next?.id == null || next.id === '';
  const sameId = typeof next?.id === 'string' && old?.id === next.id;
  return (
    oldIdPresent &&
    (newIdUnknown || sameId) &&
    old.urn === step.urn &&
    next?.urn === step.urn &&
    old.type === keyType &&
    next?.type === keyType &&
    old.provider === next?.provider
  );
}

function keyMetadata(step) {
  const old = step.oldState;
  const next = step.newState;
  return {
    oldIdsPresent: typeof old?.id === 'string' && old.id.length > 0,
    newIdsPresent: typeof next?.id === 'string' && next.id.length > 0,
    idsEqual: old?.id === next?.id,
    urnsEqual: old?.urn === step.urn && next?.urn === step.urn,
    typesEqual: old?.type === keyType && next?.type === keyType,
    providersEqual: old?.provider === next?.provider,
    annotationsPresent: secretOutputs.every((key) => secretDeclared(next, key)),
    outputsRedacted: secretOutputs.every((key) => next?.outputs?.[key] === '[secret]'),
  };
}

function includeKey(step, result) {
  const old = step.oldState;
  const next = step.newState;
  const facts = keyMetadata(step);
  for (const key of Object.keys(facts)) result.metadata[key] &&= facts[key];
  // Default preview is pre-step. SameStep copies the existing ID/outputs later;
  // a missing new ID is expected, but a supplied different ID still fails.
  result.identitiesUnchanged &&= identityPreserved(step);
  result.inputsUnchanged &&=
    JSON.stringify(old?.inputs) === JSON.stringify(next?.inputs) && next?.inputs?.byteLength === 32;
  result.protectionUnchanged &&= old?.protect === true && next?.protect === true;
  for (const key of secretOutputs) result.secretOutputs[key] &&= secretDeclared(next, key);
  return secretOutputs.every(
    (key) => secretDeclared(old, key) && old?.outputs?.[key] === '[secret]'
  );
}

function summarize(digest, stack) {
  const result = {
    verified: false,
    operationCounts: {},
    resourceTypes: [],
    existingKeyCount: 0,
    untargetedSameCount: 0,
    persistedSecretMetadataVerified: false,
    identitiesUnchanged: true,
    inputsUnchanged: true,
    protectionUnchanged: true,
    metadata: {
      oldIdsPresent: true,
      newIdsPresent: true,
      idsEqual: true,
      urnsEqual: true,
      typesEqual: true,
      providersEqual: true,
      annotationsPresent: true,
      outputsRedacted: true,
    },
    secretOutputs: Object.fromEntries(secretOutputs.map((key) => [key, true])),
  };
  if (
    !digest ||
    !Array.isArray(digest.steps) ||
    !validSummary(digest.changeSummary) ||
    digest.maybeCorrupt
  )
    return result;
  const targets = new Set(
    keyNames.map((name) => `urn:pulumi:${stack}::sam-infra::${keyType}::${name}`)
  );
  const seen = new Set();
  const types = new Set();
  let safe = !digest.diagnostics?.some((entry) => entry.severity === 'error');
  let persisted = true;
  for (const step of digest.steps) {
    const op = allowedOps.has(step.op) ? step.op : 'other';
    result.operationCounts[op] = (result.operationCounts[op] ?? 0) + 1;
    if (hasMutation(step)) safe = false;
    const type = step.newState?.type ?? step.oldState?.type;
    if (allowedTypes.has(type)) types.add(type);
    if (!targets.has(step.urn)) {
      result.untargetedSameCount += 1;
      continue;
    }
    if (seen.has(step.urn)) {
      safe = false;
      continue;
    }
    seen.add(step.urn);
    const oldPersisted = includeKey(step, result);
    persisted &&= oldPersisted;
  }
  result.existingKeyCount = seen.size;
  result.persistedSecretMetadataVerified = seen.size === keyNames.length && persisted;
  result.resourceTypes = [...types].sort((left, right) => left.localeCompare(right));
  result.verified =
    safe &&
    seen.size === keyNames.length &&
    result.identitiesUnchanged &&
    result.inputsUnchanged &&
    result.protectionUnchanged &&
    Object.values(result.secretOutputs).every(Boolean);
  return result;
}

function preview() {
  const resourceNames = resolveResourceNames(process.env, 'pulumi');
  for (const name of [
    'CF_ACCOUNT_ID',
    'CF_ZONE_ID',
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'PULUMI_CONFIG_PASSPHRASE',
  ]) {
    if (!process.env[name]) throw new Error('Missing required credential');
  }
  // The workflow resolves the pinned installer's CLI before mapping credentials.
  // Never fall back to PATH or assume a preinstalled CLI is under the home dir.
  const binary = process.env.PULUMI_METADATA_PREVIEW_BINARY;
  if (!binary || !isAbsolute(binary)) throw new Error('CLI path must be absolute');
  const timeout = Number(process.env.PULUMI_METADATA_PREVIEW_TIMEOUT_MS || 600000);
  const maxBuffer = Number(process.env.PULUMI_METADATA_PREVIEW_MAX_BYTES || 16777216);
  if (
    !Number.isSafeInteger(timeout) ||
    timeout <= 0 ||
    !Number.isSafeInteger(maxBuffer) ||
    maxBuffer <= 0
  )
    throw new Error('Invalid limits');
  const dir = mkdtempSync(join(tmpdir(), 'pulumi-metadata-preview-'));
  try {
    // Local-only runner config: do not run config set, select/init, refresh, up,
    // stack export, save-plan, or write a raw event/state/diagnostic artifact.
    const configFile = join(dir, 'config.json');
    writeFileSync(
      configFile,
      JSON.stringify({
        config: {
          'sam-infra:cloudflareAccountId': process.env.CF_ACCOUNT_ID,
          'sam-infra:cloudflareZoneId': process.env.CF_ZONE_ID,
          'sam-infra:baseDomain': resourceNames.base_domain,
          'sam-infra:resourcePrefix': resourceNames.prefix,
        },
      }),
      { mode: 0o600 }
    );
    const options = {
      cwd: new URL('../../infra/', import.meta.url),
      encoding: 'utf8',
      timeout,
      maxBuffer,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: {
        ...process.env,
        PULUMI_ENABLE_STREAMING_JSON_PREVIEW: 'false',
        PULUMI_SKIP_UPDATE_CHECK: 'true',
      },
    };
    const login = spawnSync(
      binary,
      [
        'login',
        `s3://${resourceNames.pulumi_state_bucket}?endpoint=https://${process.env.CF_ACCOUNT_ID}.r2.cloudflarestorage.com&region=auto`,
      ],
      options
    );
    if (login.error || login.status !== 0) throw new Error('Backend unavailable');
    const targets = keyNames.flatMap((name) => [
      '--target',
      `urn:pulumi:${resourceNames.stack}::sam-infra::${keyType}::${name}`,
    ]);
    const child = spawnSync(
      binary,
      [
        'preview',
        '--stack',
        resourceNames.stack,
        '--config-file',
        configFile,
        '--json',
        '--refresh=false',
        '--suppress-outputs',
        '--suppress-permalink',
        '--show-sames',
        '--non-interactive',
        ...targets,
      ],
      options
    );
    if (child.error || child.status !== 0) throw new Error('Preview unavailable');
    return summarize(JSON.parse(child.stdout), resourceNames.stack);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

let evidence;
try {
  evidence = preview();
} catch {
  evidence = { verified: false };
}
const safeOutput = `${JSON.stringify(evidence)}\n`;
process.stdout.write(safeOutput);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, safeOutput);
process.exitCode = evidence.verified ? 0 : 1;
