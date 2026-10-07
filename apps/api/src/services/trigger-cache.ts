import { clearCredentialAttributionHealthCache } from './credential-attribution-health';
import { clearProjectMultiplayerStateCache } from './project-multiplayer';

export function clearTriggerPageCaches(projectId: string): void {
  clearCredentialAttributionHealthCache(projectId);
  clearProjectMultiplayerStateCache(projectId);
}
