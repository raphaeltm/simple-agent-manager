/**
 * The engine's two installation-key steps (task 01M8C74NYMDP2YYPAG17VXJB78):
 *
 * - `applyInfrastructure`: retires the old key resources from Pulumi state as the last step before
 *   `pulumi up`, once the API Worker is shown to hold their secrets and the retirement marker is in
 *   state (retireKeyResources).
 * - `ensureInstallationKeys`: a brand-new installer installation gets its keys once, straight into
 *   its API Worker. Every other run only checks they are there, by name.
 */
import {
  createInstallationKeys,
  inspectInstallationKeys,
  requireInstallationKeys,
  type WorkerAccess,
  workerSecretNames,
} from './installation-keys.js';
import { retireKeyResources } from './retire-key-resources.js';

export interface InfrastructureSteps {
  /** URNs of the selected stack (scripts/deploy/pulumi-stack-urns.sh). */
  listUrns(): Promise<string[]>;
  refresh(): Promise<unknown>;
  /** Runs a Pulumi command with its output discarded. */
  pulumiQuiet(args: string[]): Promise<unknown>;
  up(): Promise<unknown>;
  worker: WorkerAccess;
}

export async function applyInfrastructure(steps: InfrastructureSteps): Promise<void> {
  const urns = await steps.listUrns();
  await steps.refresh();
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
 * Installer runs (not CI) create the installation keys of a brand-new installation, whose Worker
 * holds none of them, and never anything else. A Worker missing only some keys is not "an older
 * installation that never had them": every installation from before this change holds all of
 * them (its deploys set them), so a missing group means a lost one, and replacing it would rotate
 * live keys without notice (new JWT signer, dead push subscriptions). That case fails, naming the
 * missing keys; the operator decides, with `installation-keys.ts create` on their own machine.
 * ENCRYPTION_KEY is never created for an installation with users or stored credentials. CI
 * deploys only require the keys, by name.
 */
export async function ensureInstallationKeys(options: {
  mayCreate: boolean;
  freshInstallation: boolean;
  worker: WorkerAccess;
  databaseId: string;
}): Promise<void> {
  if (options.mayCreate && (await inspectInstallationKeys(options.worker)).state === 'absent')
    await createInstallationKeys(
      { ...options.worker, databaseId: options.databaseId },
      { freshInstallation: options.freshInstallation }
    );
  await requireInstallationKeys(options.worker);
}
