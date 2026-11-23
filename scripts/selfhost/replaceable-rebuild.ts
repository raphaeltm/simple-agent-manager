/**
 * `pnpm selfhost:rebuild` (rebuild.ts): puts a dead replaceable box's sealed state back on a new
 * VM from its fleet bucket (replaceable-box.ts), before `pnpm selfhost:deploy --init`.
 *
 * What it trusts: the operator's `.env` (bucket, domain, key provider and key), the VM identity's
 * access to that key, and this checkout. It never takes the provider or the key from the bucket:
 * a bundle is accepted only when its header names the key this box resolves from `.env` (or the
 * same automatic candidates `--init` uses) AND it opens under that key. A bundle written by anyone
 * else, a bundle of another installation, or a ledger that does not open stops the rebuild.
 */
import { existsSync } from 'node:fs';

import { addResource } from '../../deploy/selfhost/created-resources.mjs';
import { openBundle, type SealedBundle } from '../../deploy/selfhost/key-agent/bundle.ts';
import type { KeyProvider } from '../../deploy/selfhost/key-agent/provider.ts';
import { createKeyProvider } from '../../deploy/selfhost/key-agent/providers.ts';
import { recordPath } from './install-record.js';
import { explicitKeyProvider, type PlatformCandidates } from './key-choice.js';
import { assertNotRootForSealing, bundleStoreFor, keyServiceSettings } from './key-service.js';
import {
  type BoxBucket,
  bucketBundleIds,
  fetchLedger,
  LEDGER_SECRET,
  readBucketBundle,
  replaceableBox,
} from './replaceable-box.js';
import { ensurePrivateDir } from './secret-files.js';

type Box = Readonly<Record<string, string>>;

export interface RebuildInput {
  box: Box;
  stateDir: string;
  bucket: BoxBucket;
  /** The automatic key candidates (key-platforms.ts detectKeyCandidates in production). */
  detect: (box: Box) => Promise<PlatformCandidates>;
  log: (message: string) => void;
}

export interface RebuildResult {
  installationId: string;
  bundleIds: string[];
  ledgerEntries: number;
}

/** The provider `.env` resolves to whose key made `bundle`, or a refusal naming what was found. */
async function providerFor(input: RebuildInput, bundle: SealedBundle): Promise<KeyProvider> {
  const explicit = explicitKeyProvider(input.box);
  const candidates = explicit
    ? [{ provider: explicit, settings: {} as Record<string, string> }]
    : (await input.detect(input.box)).candidates;
  for (const candidate of candidates) {
    const settings = keyServiceSettings(
      { ...input.box, ...candidate.settings, SAM_KEY_PROVIDER: candidate.provider },
      input.stateDir
    );
    if (!settings) continue;
    const provider = createKeyProvider(settings.hostEnv);
    if (provider.name === bundle.provider && provider.keyRef === bundle.keyRef) return provider;
  }
  throw new Error(
    `the newest bundle in the bucket (${bundle.bundleId}) was sealed with ${bundle.provider} key ` +
      `${bundle.keyRef}, which this box's .env does not resolve to. Set SAM_KEY_PROVIDER and its ` +
      "key in .env to the dead box's key, and give this VM's identity access to it"
  );
}

export async function runRebuild(input: RebuildInput): Promise<RebuildResult> {
  const { box, stateDir, bucket, log } = input;
  if (!replaceableBox(box)) {
    throw new Error('rebuild needs SAM_REPLACEABLE_BOX=true in .env, as on the box it replaces');
  }
  const local = bundleStoreFor(stateDir);
  if ((await local.listIds()).length > 0 || existsSync(recordPath(stateDir))) {
    throw new Error(
      `${stateDir} already holds an install: rebuild only fills an empty state directory`
    );
  }
  const ids = bucketBundleIds(bucket);
  if (ids.length === 0) {
    throw new Error(
      `the fleet bucket ${box.CELLD_BUCKET} holds no sealed bundles under sam-box/bundles/: ` +
        'the box it replaces never deployed with SAM_REPLACEABLE_BOX=true'
    );
  }
  const bundles = ids
    .map((id) => readBucketBundle(bucket, id))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  const newest = bundles[0] as SealedBundle;
  const installationId = newest.installationId;
  if (bundles.some((b) => b.installationId !== installationId)) {
    throw new Error('the bucket holds bundles of more than one installation; refusing to choose');
  }
  assertNotRootForSealing(stateDir);
  const provider = await providerFor(input, newest);
  const accepted: SealedBundle[] = [];
  for (const bundle of bundles) {
    if (bundle.provider !== provider.name || bundle.keyRef !== provider.keyRef) {
      // An older bundle from before a provider switch: the newest decides, this one stays out.
      log(`skipping bundle ${bundle.bundleId}: sealed with ${bundle.provider} ${bundle.keyRef}`);
      continue;
    }
    const secrets = await openBundle(bundle, provider);
    if (secrets.SAM_INSTALLATION_ID !== installationId || LEDGER_SECRET in secrets) {
      throw new Error(
        `bundle ${bundle.bundleId} is not a sealed bundle of installation ${installationId}`
      );
    }
    accepted.push(bundle);
  }
  const entries = await fetchLedger(bucket, provider, installationId);
  ensurePrivateDir(stateDir);
  for (const bundle of accepted) await local.write(bundle);
  for (const entry of entries) {
    addResource(recordPath(stateDir), {
      cloud: entry.cloud,
      kind: entry.kind,
      name: entry.name,
      action: entry.action,
      createdBy: entry.createdBy,
      ...(entry.attributes ? { attributes: entry.attributes } : {}),
    });
  }
  log(
    `restored ${accepted.length} sealed bundle(s) of installation ${installationId} and ` +
      `${entries.length} cloud record entries into ${stateDir}`
  );
  return {
    installationId,
    bundleIds: accepted.map((b) => b.bundleId),
    ledgerEntries: entries.length,
  };
}
