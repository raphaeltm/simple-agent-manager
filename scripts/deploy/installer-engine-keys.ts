/**
 * The engine's two installation-key steps (task 01M8C74NYMDP2YYPAG17VXJB78):
 *
 * - `applyInfrastructure`: retires the old key resources from Pulumi state as the LAST step before
 *   `pulumi up`, after both takeover gates have passed. A refused takeover therefore leaves the
 *   deploy state exactly as it was, and the owner's old fork deploy still works. Every preview
 *   excludes the key resources (and the retirement marker), so a gate neither plans their deletion
 *   nor holds a RandomId's raw id. The takeover gate itself is unchanged.
 * - `ensureInstallationKeys`: a brand-new installer installation gets its keys once, straight into
 *   its API Worker. Every other run only checks they are there, by name.
 */
import {
  createInstallationKeys,
  requireInstallationKeys,
  type WorkerAccess,
  workerSecretNames,
} from './installation-keys.js';
import { refuseResourceChanges } from './installer-engine-adoption.js';
import { previewExcludeArgs, retireKeyResources } from './retire-key-resources.js';

export interface InfrastructureSteps {
  takeover: boolean;
  /** URNs of the selected stack (scripts/deploy/pulumi-stack-urns.sh). */
  listUrns(): Promise<string[]>;
  /** `pulumi preview <flags> --json`, output kept private. */
  previewJson(...flags: string[]): Promise<string>;
  refresh(): Promise<unknown>;
  /** Runs a Pulumi command with its output discarded. */
  pulumiQuiet(args: string[]): Promise<unknown>;
  up(): Promise<unknown>;
  worker: WorkerAccess;
}

export async function applyInfrastructure(steps: InfrastructureSteps): Promise<void> {
  const urns = await steps.listUrns();
  const exclude = previewExcludeArgs(urns);
  // The takeover gate comes first: preview --refresh reads the live resources without writing the
  // state, while the refresh below rewrites it.
  if (steps.takeover) await refuseResourceChanges(() => steps.previewJson('--refresh', ...exclude));
  await steps.refresh();
  // Checked again against the refreshed state, immediately before the update that applies it.
  if (steps.takeover)
    await refuseResourceChanges(
      () => steps.previewJson(...exclude),
      'These resources changed after the takeover was checked, so none was changed:'
    );
  await retireKeyResources({
    urns,
    listUrns: () => steps.listUrns(),
    workerSecretNames: () => workerSecretNames(steps.worker),
    pulumi: async (args) => {
      await steps.pulumiQuiet(args);
    },
  });
  await steps.up();
}

/**
 * Installer runs (not CI) create the keys the Worker lacks: every key for a brand-new installation,
 * or a whole group an older installation never had. Never ENCRYPTION_KEY for an adoption or an
 * installation that already has users or stored credentials, never a replacement. CI deploys only require them, by name.
 */
export async function ensureInstallationKeys(options: {
  mayCreate: boolean;
  freshInstallation: boolean;
  worker: WorkerAccess;
  databaseId: string;
}): Promise<void> {
  if (options.mayCreate)
    await createInstallationKeys(
      { ...options.worker, databaseId: options.databaseId },
      { freshInstallation: options.freshInstallation }
    );
  await requireInstallationKeys(options.worker);
}
