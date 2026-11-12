/**
 * Cloud key candidates for the automatic key-provider choice (key-choice.ts). Platform detection
 * by instance metadata lands with the cloud providers; until then every box gets the file key.
 */
import type { PlatformCandidates } from './key-choice.js';

export async function detectKeyCandidates(): Promise<PlatformCandidates> {
  return { platform: null, candidates: [] };
}
