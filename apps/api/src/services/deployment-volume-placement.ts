import type { CredentialProvider } from '@simple-agent-manager/shared';

import type * as schema from '../db/schema';
import { errors } from '../middleware/error';

interface VolumePlacementConstraint {
  provider: CredentialProvider;
  location: string;
}

export function resolveVolumePlacementConstraint(
  volumes: schema.DeploymentVolumeRow[]
): VolumePlacementConstraint | null {
  const first = volumes[0];
  if (!first) return null;

  for (const volume of volumes) {
    if (volume.providerName !== first.providerName || volume.location !== first.location) {
      throw errors.conflict(
        'Deployment environment volumes must all use the same provider and location before the environment can be started.'
      );
    }
  }

  return {
    provider: first.providerName as CredentialProvider,
    location: first.location,
  };
}
