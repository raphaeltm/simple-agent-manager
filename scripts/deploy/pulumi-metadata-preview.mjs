// Run only on the existing GitHub environment runner. Never emit Pulumi output,
// resource IDs, URNs, config values, diagnostics, or old/new property values.
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

function summarize(digest, stack) {
  const result = {
    verified: false,
    operationCounts: {},
    resourceTypes: [],
    existingKeyCount: 0,
    identitiesUnchanged: true,
    inputsUnchanged: true,
    protectionUnchanged: true,
    secretOutputs: Object.fromEntries(secretOutputs.map((key) => [key, true])),
  };
  if (
    !digest ||
    !Array.isArray(digest.steps) ||
    !digest.changeSummary ||
    typeof digest.changeSummary !== 'object' ||
    Array.isArray(digest.changeSummary) ||
    !Number.isSafeInteger(digest.changeSummary.same) ||
    digest.changeSummary.same < keyNames.length ||
    digest.maybeCorrupt
  )
    return result;
  const seen = new Set();
  const types = new Set();
  let safe = true;
  for (const step of digest.steps) {
    const op = allowedOps.has(step.op) ? step.op : 'other';
    result.operationCounts[op] = (result.operationCounts[op] ?? 0) + 1;
    // A metadata-only annotation update should not ask the provider to mutate.
    if (
      op !== 'same' ||
      step.replaceReasons?.length ||
      step.diffReasons?.length ||
      Object.keys(step.detailedDiff ?? {}).length
    )
      safe = false;
    const type = step.newState?.type ?? step.oldState?.type;
    if (!allowedTypes.has(type)) {
      safe = false;
      continue;
    }
    types.add(type);
    if (type !== keyType) continue;
    const name = keyNames.find(
      (candidate) => step.urn === `urn:pulumi:${stack}::sam-infra::${keyType}::${candidate}`
    );
    if (!name || seen.has(name)) {
      safe = false;
      continue;
    }
    seen.add(name);
    const old = step.oldState;
    const next = step.newState;
    // Compare inside the trusted runner; return booleans only, never the IDs.
    result.identitiesUnchanged &&=
      typeof old?.id === 'string' &&
      old.id.length > 0 &&
      old.id === next?.id &&
      old.urn === step.urn &&
      next?.urn === step.urn &&
      old.type === keyType &&
      next?.type === keyType &&
      old.provider === next?.provider;
    result.inputsUnchanged &&=
      JSON.stringify(old?.inputs) === JSON.stringify(next?.inputs) &&
      next?.inputs?.byteLength === 32;
    result.protectionUnchanged &&= old?.protect === true && next?.protect === true;
    for (const key of secretOutputs) {
      // Pulumi's preview digest renders annotated output properties as [secret].
      result.secretOutputs[key] &&=
        next?.additionalSecretOutputs?.includes(key) === true &&
        next?.outputs?.[key] === '[secret]';
    }
  }
  // Check the engine summary too, so a step omitted from display cannot hide a
  // mutation. Never relay arbitrary operation/type strings from child output.
  for (const [op, count] of Object.entries(digest.changeSummary)) {
    if (
      !allowedOps.has(op) ||
      !Number.isSafeInteger(count) ||
      count < 0 ||
      (op !== 'same' && count !== 0)
    )
      safe = false;
  }
  if (digest.diagnostics?.some((entry) => entry.severity === 'error')) safe = false;
  result.existingKeyCount = seen.size;
  result.resourceTypes = [...types].sort();
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
      'pulumi',
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
      'pulumi',
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
