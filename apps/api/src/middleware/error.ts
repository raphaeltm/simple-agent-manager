// Moved to @simple-agent-manager/worker-core (worker modularization W0). This re-export keeps
// existing importers unchanged; new code imports from the package entry point directly.
import { AppError, errors as coreErrors } from '@simple-agent-manager/worker-core';

import type { PlatformCapability } from '../services/platform-capabilities';

export { AppError };

/**
 * The package's error helpers plus `featureUnavailable`, which names a worker-side
 * capability (services/platform-capabilities.ts) and so stays in the worker.
 */
export const errors = {
  ...coreErrors,

  /**
   * A platform service this installation does not have (for example Workers AI off
   * Cloudflare). A designed 4xx: the request was valid, the installation cannot serve it,
   * and retrying will not help. `feature` names the capability in
   * services/platform-capabilities.ts.
   */
  featureUnavailable: (feature: PlatformCapability, message: string) =>
    new AppError(404, 'FEATURE_UNAVAILABLE', message, { feature }),
};
