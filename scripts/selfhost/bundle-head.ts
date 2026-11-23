/**
 * Which sealed bundle is current: the authoritative head, and the one selector every caller uses
 * (the deploy, `secrets rotate`, `secrets switch`, the replaceable box's reconcile and rebuild).
 *
 * Bundles used to be ordered by their `createdAt` header. A host clock that moved backwards
 * between two seals made the bundle sealed last look older, so the next deploy named the earlier
 * one and silently rolled back a rotation, a `secrets.env` edit or an `--unset` (ideas
 * 01M83X8B5QEZYW056030YGWCG6 and 01M7W2QMJ4MFVXT4Q06DCAWP1K). The head records the bundle each
 * seal makes current, with a write sequence that only grows, so no clock decides anything.
 *
 * The head file (`.state/key-agent/head.json`, and `sam-box/head.json` on a replaceable box):
 *
 *   { format, seq, bundleId, installationId, seal }
 *
 * `seal` is a sealed bundle (bundle.ts) holding one secret, SAM_BUNDLE_HEAD, whose value repeats
 * `{seq, bundleId, installationId}`. It is sealed with the key of the bundle it names, so whoever
 * can open that bundle can verify the head, and nobody without the key can forge or edit one.
 * The plaintext copy of the fields is a hint for read-only display; every decision opens the
 * seal (openHead) and refuses a head whose fields differ, whose seal belongs to another
 * installation, or that names a bundle that is missing or of another installation.
 *
 * A box from before the head has none: selectCurrentBundle falls back to the newest `createdAt`,
 * the rule that box has always deployed by, and the next deploy writes a head naming that same
 * bundle (key-seal.ts). After that, `createdAt` decides only which older bundles prune keeps.
 */
import {
  openBundle,
  parseBundle,
  type SealedBundle,
  sealSecrets,
  type Secrets,
} from '../../deploy/selfhost/key-agent/bundle.ts';
import type { BundleStore } from '../../deploy/selfhost/key-agent/bundle-store.ts';
import type { KeyProvider } from '../../deploy/selfhost/key-agent/provider.ts';

export const HEAD_FORMAT = 'sam-bundle-head/1';
/** The one secret a sealed head holds; a bundle holding it is not a Worker bundle. */
export const HEAD_SECRET = 'SAM_BUNDLE_HEAD';

const HEX32 = /^[0-9a-f]{32}$/;

export interface BundleHead {
  /** Grows by one at every head write; compares a box's head with its bucket copy. */
  seq: number;
  bundleId: string;
  installationId: string;
}

interface HeadFile extends BundleHead {
  format: typeof HEAD_FORMAT;
  seal: SealedBundle;
}

function headFields(value: unknown, what: string): BundleHead {
  const r = value as Record<string, unknown> | null;
  if (
    !r ||
    typeof r !== 'object' ||
    !Number.isSafeInteger(r.seq) ||
    (r.seq as number) < 1 ||
    typeof r.bundleId !== 'string' ||
    !HEX32.test(r.bundleId) ||
    typeof r.installationId !== 'string' ||
    !HEX32.test(r.installationId)
  ) {
    throw new Error(`${what} is not a valid bundle head`);
  }
  return { seq: r.seq as number, bundleId: r.bundleId, installationId: r.installationId };
}

function parseHeadFile(text: string, where: string): HeadFile {
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${where} is not JSON`);
  }
  const record = raw as Record<string, unknown> | null;
  if (!record || typeof record !== 'object' || record.format !== HEAD_FORMAT) {
    throw new Error(`${where} is not a ${HEAD_FORMAT} head`);
  }
  const fields = headFields(record, where);
  let seal: SealedBundle;
  try {
    seal = parseBundle(JSON.stringify(record.seal));
  } catch {
    throw new Error(`${where} has no valid seal`);
  }
  return { format: HEAD_FORMAT, ...fields, seal };
}

/**
 * The head's plaintext fields, NOT verified: only for messages and read-only tools (status, the
 * provider hint of the automatic key choice). Never decide what to deploy, seal or prune by it.
 */
export function headHint(text: string | null, where = 'the bundle head'): BundleHead | null {
  if (text === null) return null;
  const { seq, bundleId, installationId } = parseHeadFile(text, where);
  return { seq, bundleId, installationId };
}

/**
 * The current bundle by the head's UNVERIFIED hint, else the newest `createdAt`: for tools that
 * open no key (status, the automatic key choice's provider match, the installation id a state
 * directory carries). A forged hint can only mislabel; any action re-selects with
 * selectCurrentBundle, which verifies.
 */
export function currentByHint<T extends Pick<SealedBundle, 'bundleId' | 'createdAt'>>(
  bundles: readonly T[],
  headText: string | null
): T | undefined {
  const named = headHint(headText)?.bundleId;
  const ordered = byCreatedAt(bundles);
  return ordered.find((b) => b.bundleId === named) ?? ordered[0];
}

/** Which key sealed the head (plaintext), so a caller can pick the provider that opens it. */
export function headSealKey(
  text: string,
  where = 'the bundle head'
): {
  provider: string;
  keyRef: string;
} {
  const { seal } = parseHeadFile(text, where);
  return { provider: seal.provider, keyRef: seal.keyRef };
}

/**
 * Opens and checks a head under `provider`. Throws on anything but a head sealed by this key for
 * the installation it names, with the same fields inside the seal as outside.
 */
export async function openHead(
  text: string,
  provider: KeyProvider,
  where = 'the bundle head'
): Promise<BundleHead> {
  const file = parseHeadFile(text, where);
  if (file.seal.installationId !== file.installationId) {
    throw new Error(`${where} is sealed for another installation; refusing it`);
  }
  // Sealed with the key of the bundle it names (commitHead): a box configured for another key
  // could not open that bundle either. Said before any key-service call, as openBundle does.
  if (file.seal.provider !== provider.name || file.seal.keyRef !== provider.keyRef) {
    throw new Error(
      `${where} names bundle ${file.bundleId}; bundle ${file.bundleId} was sealed with ` +
        `${file.seal.provider} key ${file.seal.keyRef}, but this box is configured for ` +
        `${provider.name} key ${provider.keyRef}`
    );
  }
  let secrets: Secrets;
  try {
    secrets = await openBundle(file.seal, provider);
  } catch (error) {
    throw new Error(
      `${where} does not open under ${provider.name} ${provider.keyRef} ` +
        `(${error instanceof Error ? error.message : String(error)}); refusing it`
    );
  }
  const names = Object.keys(secrets);
  if (names.length !== 1 || names[0] !== HEAD_SECRET) throw new Error(`${where} is not a head`);
  let inner: unknown;
  try {
    inner = JSON.parse(secrets[HEAD_SECRET] ?? '') as unknown;
  } catch {
    throw new Error(`${where} is not a head`);
  }
  const sealed = headFields(inner, where);
  if (
    sealed.seq !== file.seq ||
    sealed.bundleId !== file.bundleId ||
    sealed.installationId !== file.installationId
  ) {
    throw new Error(`${where} was edited after it was sealed; refusing it`);
  }
  return sealed;
}

/** The head file's text for `head`, sealed with `provider` (the key of the bundle it names). */
export async function sealHead(head: BundleHead, provider: KeyProvider): Promise<string> {
  const fields = headFields(head, 'the new head');
  const seal = await sealSecrets({ [HEAD_SECRET]: JSON.stringify(fields) }, provider, {
    installationId: fields.installationId,
  });
  return `${JSON.stringify({ format: HEAD_FORMAT, ...fields, seal }, null, 2)}\n`;
}

/** Bundles newest `createdAt` first: the order of the fallback and of the older bundles kept. */
export function byCreatedAt<T extends Pick<SealedBundle, 'createdAt'>>(bundles: readonly T[]): T[] {
  return [...bundles].sort((a, b) =>
    a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0
  );
}

export interface CurrentBundle {
  /** The current bundle, or undefined when there is none at all. */
  bundle: SealedBundle | undefined;
  /** The verified head, or null when the box has none yet (the createdAt fallback chose). */
  head: BundleHead | null;
}

/**
 * THE selector: the bundle the head names, verified, or without a head the newest `createdAt`.
 * `bundles` are every readable bundle of the store. Throws (fail closed) when the head does not
 * verify or names a bundle that is not there or belongs to another installation.
 */
export async function selectCurrentBundle(
  bundles: readonly SealedBundle[],
  headText: string | null,
  provider: KeyProvider | (() => KeyProvider),
  where = 'the bundle head'
): Promise<CurrentBundle> {
  if (headText === null) return { bundle: byCreatedAt(bundles)[0], head: null };
  const key = typeof provider === 'function' ? provider() : provider;
  const head = await openHead(headText, key, where);
  const bundle = bundles.find((b) => b.bundleId === head.bundleId);
  if (!bundle) {
    throw new Error(
      `${where} names bundle ${head.bundleId}, which is not there; refusing to fall back to an ` +
        'older bundle. Restore it from backup (pnpm selfhost:restore)'
    );
  }
  if (bundle.installationId !== head.installationId) {
    throw new Error(
      `${where} names bundle ${head.bundleId} of installation ${bundle.installationId}, but the ` +
        `head belongs to ${head.installationId}; refusing it`
    );
  }
  return { bundle, head };
}

/** The opened secrets must name the head's installation (rule: bound to the opened bundle). */
export function assertSecretsMatchHead(
  head: BundleHead | null,
  secrets: Readonly<Secrets>,
  where = 'the bundle head'
): void {
  if (head && secrets.SAM_INSTALLATION_ID !== head.installationId) {
    throw new Error(
      `${where} names bundle ${head.bundleId}, whose secrets are not installation ` +
        `${head.installationId}; refusing it`
    );
  }
}

/**
 * Makes `bundle` (already written to the store) current: the head's seq is one past `previous`.
 * `provider` must be the bundle's own key, so whoever opens the bundle can verify the head.
 */
export async function commitHead(
  store: BundleStore,
  bundle: SealedBundle,
  provider: KeyProvider,
  previous: BundleHead | null
): Promise<BundleHead> {
  // Compare before replacing: another seal (a deploy racing a rotation or a switch) that made
  // its own bundle current since `previous` was read must not be overwritten by this one, whose
  // secrets were derived from the older state. Not atomic, but the window is this one read.
  const now = headHint(await store.readHead());
  if (
    (previous === null) !== (now === null) ||
    (previous && now && (now.seq !== previous.seq || now.bundleId !== previous.bundleId))
  ) {
    throw new Error(
      `the current sealed bundle changed while bundle ${bundle.bundleId} was being sealed ` +
        `(now ${now ? `${now.bundleId}, write ${now.seq}` : 'none'}); another deploy, rotation ` +
        'or switch ran at the same time. Run again.'
    );
  }
  const head: BundleHead = {
    seq: (previous?.seq ?? 0) + 1,
    bundleId: bundle.bundleId,
    installationId: bundle.installationId,
  };
  await store.writeHead(await sealHead(head, provider));
  return head;
}

/**
 * The bundles a prune keeps: the current one, the one it replaced (the Worker version still
 * running during the deploy asks for it), then the newest others by `createdAt`, up to `keep`.
 */
export function keptBundleIds(
  bundles: readonly SealedBundle[],
  current: string,
  previous: string | undefined,
  keep: number
): string[] {
  const ordered = [current, ...(previous ? [previous] : [])];
  for (const b of byCreatedAt(bundles)) if (!ordered.includes(b.bundleId)) ordered.push(b.bundleId);
  return ordered.slice(0, Math.max(keep, previous ? 2 : 1));
}
