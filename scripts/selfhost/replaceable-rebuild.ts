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
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { addResource } from '../../deploy/selfhost/created-resources.mjs';
import { openBundle, type SealedBundle } from '../../deploy/selfhost/key-agent/bundle.ts';
import type { KeyProvider } from '../../deploy/selfhost/key-agent/provider.ts';
import { createKeyProvider } from '../../deploy/selfhost/key-agent/providers.ts';
import { byCreatedAt, currentByHint, selectCurrentBundle } from './bundle-head.js';
import { recordPath } from './install-record.js';
import { explicitKeyProvider, type PlatformCandidates } from './key-choice.js';
import {
  assertNotRootForSealing,
  bundleStoreFor,
  DEFAULT_KEPT_BUNDLES,
  KEY_AGENT_DIR,
  keyServiceSettings,
} from './key-service.js';
import {
  type BoxBucket,
  bucketBundleIds,
  bucketHead,
  fetchLedger,
  HEAD_KEY,
  LEDGER_SECRET,
  readBucketBundle,
  REBUILD_MARKER,
  replaceableBox,
} from './replaceable-box.js';
import { ensurePrivateDir, writePrivateFile } from './secret-files.js';

type Box = Readonly<Record<string, string>>;

export interface RebuildInput {
  box: Box;
  stateDir: string;
  bucket: BoxBucket;
  /** The automatic key candidates (key-platforms.ts detectKeyCandidates in production). */
  detect: (box: Box) => Promise<PlatformCandidates>;
  log: (message: string) => void;
  /** `--installation-id`: the id the operator knows the dead box by; refuses any other. */
  expectedInstallationId?: string;
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
    `the current bundle in the bucket (${bundle.bundleId}) was sealed with ${bundle.provider} key ` +
      `${bundle.keyRef}, which this box's .env does not resolve to. Set SAM_KEY_PROVIDER and its ` +
      "key in .env to the dead box's key, and give this VM's identity access to it"
  );
}

export async function runRebuild(input: RebuildInput): Promise<RebuildResult> {
  const { box, stateDir, bucket, log } = input;
  if (!replaceableBox(box)) {
    throw new Error('rebuild needs SAM_REPLACEABLE_BOX=true in .env, as on the box it replaces');
  }
  const ids = bucketBundleIds(bucket);
  if (ids.length === 0) {
    throw new Error(
      `the fleet bucket ${box.CELLD_BUCKET} holds no sealed bundles under sam-box/bundles/: ` +
        'the box it replaces never deployed with SAM_REPLACEABLE_BOX=true'
    );
  }
  // Resumable: a state directory holding only bundles this bucket has (a rebuild that stopped
  // part way) is completed; anything else is another install, which rebuild never touches.
  const local = bundleStoreFor(stateDir);
  const present = await local.listIds();
  // Bundles are written before the record, so a record with no bundle is another install's.
  if (
    present.some((id) => !ids.includes(id)) ||
    (present.length === 0 &&
      existsSync(recordPath(stateDir)) &&
      !existsSync(join(stateDir, REBUILD_MARKER)))
  ) {
    throw new Error(
      `${stateDir} already holds an install: rebuild only fills an empty state directory`
    );
  }
  // A corrupt object stops the rebuild, naming it: skipping it could restore an older bundle.
  const bundles = byCreatedAt(
    ids.map((id) => {
      try {
        return readBucketBundle(bucket, id);
      } catch (error) {
        throw new Error(
          `sam-box/bundles/${id}.json in the fleet bucket is not a readable sealed bundle ` +
            `(${error instanceof Error ? error.message : String(error)}); restore or remove it, then run rebuild again`
        );
      }
    })
  );
  const installationId = (bundles[0] as SealedBundle).installationId;
  if (bundles.some((b) => b.installationId !== installationId)) {
    throw new Error('the bucket holds bundles of more than one installation; refusing to choose');
  }
  if (input.expectedInstallationId && input.expectedInstallationId !== installationId) {
    throw new Error(
      `the bucket's bundles belong to installation ${installationId}, not ` +
        `${input.expectedInstallationId} (--installation-id)`
    );
  }
  assertNotRootForSealing(stateDir);
  // The bundle the dead box would have deployed next, by the same selector its deploy used
  // (bundle-head.ts): the bucket's head, verified under the key .env resolves to; a bucket from
  // before the head, the newest createdAt. The head names its bundle in plaintext only so the
  // right key can be found; it counts once it opens under that key.
  const headText = bucketHead(bucket);
  const hinted = currentByHint(bundles, headText) as SealedBundle;
  const provider = await providerFor(input, hinted);
  const { bundle: current, head } = await selectCurrentBundle(
    bundles,
    headText,
    provider,
    `${HEAD_KEY} in the fleet bucket`
  );
  if (!current) throw new Error('the fleet bucket holds no current bundle');
  if (head) log(`the bucket's head names bundle ${current.bundleId} (write ${head.seq})`);
  const accepted: SealedBundle[] = [];
  // The current bundle first, then the newest others.
  for (const bundle of [current, ...bundles.filter((b) => b !== current)]) {
    if (accepted.length >= DEFAULT_KEPT_BUNDLES) break;
    if (bundle.provider !== provider.name || bundle.keyRef !== provider.keyRef) {
      // An older bundle from before a provider switch: the current one decides, this stays out.
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
  if (entries === null) {
    log(
      'WARNING: the fleet bucket holds no sam-box/ledger.json: if the dead box ran ' +
        'pnpm selfhost:gcp-bootstrap, record what it created by hand before a teardown'
    );
  }
  ensurePrivateDir(stateDir);
  // Until the record is complete, deploy and every seal refuse this state (assertNoPendingRebuild).
  ensurePrivateDir(join(stateDir, KEY_AGENT_DIR));
  writePrivateFile(join(stateDir, REBUILD_MARKER), `${installationId}\n`);
  // The current bundle first, then older ones, then the record: a rebuild that stops part way
  // leaves the current one on the box (and the marker stops every seal) and is completed by
  // running it again. A bundle already present must be the bucket's, byte for byte.
  for (const bundle of accepted) {
    if (present.includes(bundle.bundleId)) {
      if (
        (await local.read(bundle.bundleId)) !==
        bucket.read(`sam-box/bundles/${bundle.bundleId}.json`)
      ) {
        throw new Error(
          `${stateDir} holds a bundle ${bundle.bundleId} that differs from the bucket's`
        );
      }
      continue;
    }
    await local.write(bundle);
  }
  // The bucket's head, byte for byte: the rebuilt box's deploy picks what the dead box would have,
  // and its next reconcile sees the same write on both sides.
  if (headText !== null) await local.writeHead(headText);
  for (const entry of entries ?? []) {
    addResource(recordPath(stateDir), {
      cloud: entry.cloud,
      kind: entry.kind,
      name: entry.name,
      action: entry.action,
      createdBy: entry.createdBy,
      ...(entry.attributes ? { attributes: entry.attributes } : {}),
    });
  }
  rmSync(join(stateDir, REBUILD_MARKER));
  log(
    `restored ${accepted.length} sealed bundle(s) of installation ${installationId}, the current ` +
      `${current.bundleId} sealed ${current.createdAt} (check it is the dead box's latest seal), ` +
      `and ${entries?.length ?? 0} cloud record entries into ${stateDir}`
  );
  return {
    installationId,
    bundleIds: accepted.map((b) => b.bundleId),
    ledgerEntries: entries?.length ?? 0,
  };
}
