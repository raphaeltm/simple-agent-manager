/**
 * The deploy's two steps for a replaceable box (replaceable-box.ts), both no-ops on any other box:
 * before anything is sealed, the bucket's copy of the bundles is reconciled with the box (and a
 * replacement box that skipped `pnpm selfhost:rebuild` is stopped); once the install record is
 * written, its cloud entries are sealed to `sam-box/ledger.json`.
 */
import { createKeyProvider } from '../../deploy/selfhost/key-agent/providers.ts';
import { bundleStoreFor, keyServiceSettings } from './key-service.js';
import {
  assertReplaceableSetup,
  type BoxBucket,
  fleetBucket,
  ledgerEntries,
  publishLedger,
  reconcileBundleMirror,
  replaceableBox,
} from './replaceable-box.js';

type Box = Readonly<Record<string, string | undefined>>;

export async function reconcileReplaceableBox(
  box: Box,
  stateDir: string,
  log: (message: string) => void,
  bucket: BoxBucket = fleetBucket(box)
): Promise<void> {
  if (!replaceableBox(box)) return;
  assertReplaceableSetup(box, box.SAM_KEY_PROVIDER?.trim() ?? '');
  await reconcileBundleMirror(bundleStoreFor(stateDir), bucket, log);
}

export async function publishReplaceableLedger(
  box: Box,
  stateDir: string,
  installationId: string,
  log: (message: string) => void,
  bucket: BoxBucket = fleetBucket(box)
): Promise<void> {
  if (!replaceableBox(box)) return;
  const settings = keyServiceSettings(box, stateDir);
  if (!settings) return;
  const entries = ledgerEntries(stateDir);
  await publishLedger(bucket, createKeyProvider(settings.hostEnv), installationId, entries);
  log(`sealed ${entries.length} cloud record entries to the fleet bucket (sam-box/ledger.json)`);
}
