/**
 * What the self-host (celld) build adds to the shared Worker entry, applied once by the generated
 * celld entry (`scripts/selfhost/celld-project.ts`) before any request. `apps/api/src/index.ts`
 * never imports this module, so the Cloudflare bundle carries none of it
 * (tests/unit/selfhost/reverse-tunnel-placement.test.ts).
 *
 * - speech-to-text and read-aloud through admin-configured endpoints (`speech/`, L14);
 * - the reverse-tunnel transport, gateway routes and lease sweep (`reverse-tunnel/entry.ts`,
 *   L17b), with the shared cloud-init generator as the frpc boot renderer.
 */
import { generateCloudInit } from '@simple-agent-manager/cloud-init';

import { type SharedWorkerEntry, withReverseTunnel } from './reverse-tunnel/entry';
import { installSpeechEndpoints } from './speech';

export function withSelfHostBuild<T extends SharedWorkerEntry>(worker: T): T {
  installSpeechEndpoints();
  return withReverseTunnel(worker, generateCloudInit);
}
