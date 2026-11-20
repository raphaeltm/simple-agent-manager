/**
 * The floor every automatic key choice keeps (key-choice.ts chooseKeyProvider, `secrets switch
 * --to auto`, `secrets status`): never seal with a provider weaker than a key the operator
 * configured, or one that exists but cannot be used, and say what to run to fix it.
 */
import { LEGACY_KEY_PROVIDER } from '../../deploy/selfhost/key-agent/providers.ts';
import type { CandidateFailure, KeyCandidate } from './key-choice.js';

type Box = Readonly<Record<string, string | undefined>>;

/**
 * How strongly a provider keeps the sealed secrets: 0 plaintext deploy vars (legacy), 1 a key
 * file on this box, next to the bundles it opens, 2 a key held by a service off the box (Cloud
 * KMS, Key Vault, AWS KMS, Vault transit). Off-box providers rank alike: moving between them is a
 * choice, not a downgrade.
 */
export function sealingStrength(provider: string): number {
  if (provider === LEGACY_KEY_PROVIDER) return 0;
  return provider === 'file' ? 1 : 2;
}

/** Something that rules out a weaker automatic choice, in plain words. */
export interface SealingFloor {
  /** The provider the box should seal with at least as strongly as. */
  provider: string;
  why: string;
  /** What to run to make that provider usable, when there is one thing to say. */
  fix?: string;
}

/**
 * The command a refused automatic choice is retried with (box round R15, G4: "run the same command
 * again" after a bootstrap command read as "run the bootstrap again"). `switch --to auto` passes
 * its own.
 */
const DEFAULT_RERUN = '`pnpm selfhost:deploy --init`';

/**
 * THE rule for every automatic choice of a key provider (chooseKeyProvider, reached by
 * `deploy --init`, `secrets migrate` through it, and `secrets switch --to auto`): never seal with
 * a provider weaker (sealingStrength) than any floor, where a floor is
 *  - a cloud key configured in `.env` (the operator asked for it), whether or not this machine's
 *    platform produced a candidate for it (configuredKeyFloors),
 *  - a conventional-name cloud key that could not be used for any reason other than the key
 *    service saying the key does not exist (KeyProviderError.keyMissing): denied (which Google
 *    Cloud and AWS also answer for a key the VM may not see), no enabled version, disabled, no VM
 *    identity, unreachable,
 *  - the provider the box is sealed with now (`switch --to auto`).
 * Returns the error to stop with, or null when `chosen` is allowed. Choosing a weaker provider on
 * purpose stays possible, and explicit: SAM_KEY_PROVIDER in .env or `switch --to file`.
 */
export function sealingFloorRefusal(
  chosen: string,
  floors: readonly SealingFloor[],
  rerun: string = DEFAULT_RERUN
): string | null {
  const above = floors.filter((f) => sealingStrength(f.provider) > sealingStrength(chosen));
  if (above.length === 0) return null;
  const fixes = above.flatMap((f) => (f.fix ? [f.fix] : []));
  return [
    `refusing to seal this box's secrets with ${chosen === 'file' ? 'a key file on this box' : chosen}:`,
    `${above.map((f) => f.why).join('; ')}.`,
    'A key file on the box is weaker than a key held off it (it sits next to the secrets it opens),',
    'and SAM does not fall back to a weaker key by itself.',
    ...fixes,
    `Then run ${rerun} again on this box, in the SAM checkout.`,
    'To seal with a key file on purpose, say so: set',
    'SAM_KEY_PROVIDER=file in .env for `pnpm selfhost:deploy --init`, or run',
    '`pnpm selfhost:secrets switch --to file` on a sealed box.',
  ].join(' ');
}

/**
 * The `gcloud` commands (README, Cloud key, one-time setup) that give a Google Cloud key an
 * enabled primary version and grant the box VM's service account use of it on that key only.
 */
function gcpKeyFixCommand(candidate: KeyCandidate): string {
  const key = candidate.settings.SAM_GCP_KMS_KEY ?? '';
  const parts =
    /^projects\/([^/]+)\/locations\/([^/]+)\/keyRings\/([^/]+)\/cryptoKeys\/([^/]+)$/.exec(key);
  const [project, location, ring, name] = parts
    ? [parts[1], parts[2], parts[3], parts[4]]
    : ['<project>', '<location>', '<key ring>', '<key>'];
  const where = `--keyring ${ring} --location ${location} --project ${project}`;
  return (
    `\`gcloud kms keys versions create --key ${name} ${where} --primary\` (only if it has no ` +
    `enabled version), then \`gcloud kms keys add-iam-policy-binding ${name} ${where} ` +
    `--member serviceAccount:${candidate.boxServiceAccount ?? "<the box VM's service account>"} ` +
    '--role roles/cloudkms.cryptoKeyEncrypterDecrypter` (README, Cloud key, one-time setup)'
  );
}

/** What to run for a candidate that exists but cannot be used, when the failure says enough. */
export function candidateFix(
  box: Box,
  candidate: KeyCandidate,
  failure: CandidateFailure
): string | undefined {
  if (candidate.provider === 'gcp-kms' && failure.text.includes('FAILED_PRECONDITION')) {
    return (
      'FAILED_PRECONDITION from Cloud KMS means the key has no enabled primary version (its ' +
      `versions are disabled or scheduled for destruction). Add one: ${gcpKeyFixCommand(candidate)}.`
    );
  }
  // Box round R14: on a new box whose bootstrap stopped at a destroyed key, the box account has
  // no grant yet, so Cloud KMS answers 403 and never gets to FAILED_PRECONDITION. Name that cause
  // too, with the same command (it also adds the grant).
  if (candidate.provider === 'gcp-kms' && failure.kind === 'denied') {
    return (
      'Cloud KMS answers denied (403) when the box VM may not see the key, so this can be any of: ' +
      "the key's versions are destroyed or scheduled for destruction, the box VM's service " +
      'account has no grant on the key, the VM lacks the cloud-platform access scope, or no key ' +
      `by that name was set up for this install. To fix it: ${gcpKeyFixCommand(candidate)}.`
    );
  }
  if (failure.kind === 'denied') {
    return (
      'denied means no key by that name was set up for this install (AWS also answers denied for ' +
      'a key the VM may not see), or the box VM identity may not use it: run the one-time setup ' +
      '(README, Cloud key, one-time setup), or check the grant on the key.'
    );
  }
  if (failure.kind === 'config' && !failure.keyMissing) {
    return (
      'The VM identity or the key settings are not usable here (no service account or instance ' +
      'role attached, or a key of the wrong kind).'
    );
  }
  return undefined;
}

/** `.env` settings that name an off-box key, by the provider that uses them. */
const CONFIGURED_KEY_SETTINGS: ReadonlyArray<readonly [setting: string, provider: string]> = [
  ['SAM_GCP_KMS_KEY', 'gcp-kms'],
  ['SAM_AWS_KMS_KEY_ID', 'aws-kms'],
  ['SAM_AZURE_KEY_VAULT_URL', 'azure-kv'],
  ['SAM_TRANSIT_ADDR', 'transit'],
];

/**
 * A floor for every off-box key configured in `.env` that no candidate tried: the metadata probe
 * found no platform (timed out, or not on that cloud), the platform is another cloud, or the
 * provider is never a candidate (transit). The operator asked for that key, so the file key must
 * not be chosen in its place (security review M1).
 */
export function configuredKeyFloors(
  box: Box,
  candidates: readonly KeyCandidate[],
  platform: string | null
): SealingFloor[] {
  return CONFIGURED_KEY_SETTINGS.filter(
    ([setting]) =>
      (box[setting]?.trim() ?? '') !== '' && !candidates.some((c) => c.configuredBy === setting)
  ).map(([setting, provider]) => ({
    provider,
    why:
      `${setting} is set in .env, but ` +
      (platform ? `this machine is on ${platform}` : 'no cloud instance identity was detected') +
      `, so the ${provider} key it names was not tried`,
    fix:
      `To use that key, set SAM_KEY_PROVIDER=${provider} in .env; if the ${setting} line is ` +
      'left over, remove it.',
  }));
}

/** The floor a failed candidate sets, or null when its failure says nothing was set up. */
export function candidateFloor(
  box: Box,
  candidate: KeyCandidate,
  failure: CandidateFailure
): SealingFloor | null {
  const fix = candidateFix(box, candidate, failure);
  if (candidate.configuredBy) {
    return {
      provider: candidate.provider,
      why: `${candidate.configuredBy} is set in .env, and ${candidate.label} is not usable (${failure.text})`,
      fix,
    };
  }
  // The key service said the key does not exist (404 on the key, NotFoundException): no key was
  // set up for this install, so the key file is the documented default. Not every `config`
  // failure: a VM with no identity attached is also `config`, and must stop (security review M2).
  if (failure.keyMissing) return null;
  if (failure.kind === 'unavailable') {
    return {
      provider: candidate.provider,
      why: `${candidate.label} could not be reached (${failure.text})`,
      fix: 'Unreachable is not an answer: check the network and try again.',
    };
  }
  return {
    provider: candidate.provider,
    why: `${candidate.label} is not usable (${failure.text})`,
    fix,
  };
}
