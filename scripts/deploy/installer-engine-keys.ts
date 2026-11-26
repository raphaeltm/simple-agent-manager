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
 * Installer runs (not CI) create the keys the Worker lacks: every key for a brand-new installation,
 * or a whole group an older installation never had. Never ENCRYPTION_KEY for an installation that
 * already has users or stored credentials, never a replacement. CI deploys only require them, by name.
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
