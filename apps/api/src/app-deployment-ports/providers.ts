/** Worker implementation of the app-deployment `DeploymentProviderPort`. */
import type { DeploymentProviderPort } from '../app-deployment';
import type { Env } from '../env';
import { getCredentialEncryptionKey } from '../lib/secrets';
import { createProviderForUser } from '../services/provider-credentials';

export function createDeploymentProviderPort(env: Env): DeploymentProviderPort {
  return {
    createProviderForUser: (db, userId, targetProvider, projectId) =>
      createProviderForUser(
        db,
        userId,
        getCredentialEncryptionKey(env),
        env,
        targetProvider,
        projectId
      ),
  };
}
