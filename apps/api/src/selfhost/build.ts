/**
 * What the self-host (celld) build adds to the shared Worker entry, applied once by the generated
 * celld entry (`scripts/selfhost/celld-project.ts`) before any request. `apps/api/src/index.ts`
 * never imports this module, so the Cloudflare bundle carries none of it
 * (tests/unit/selfhost/reverse-tunnel-placement.test.ts).
 *
 * - speech-to-text and read-aloud through admin-configured endpoints (`speech/`);
 * - product analytics in OBSERVABILITY_DATABASE when ANALYTICS_SINK="d1" (`analytics/`),
 *   with its `analytics.d1.*` retention settings;
 * - the reverse-tunnel transport, gateway routes and lease sweep (`reverse-tunnel/entry.ts`),
 *   with the shared cloud-init generator as the frpc boot renderer;
 * - the box's own DNS zone when SAM_DNS_PROVIDER="box" (`dns/`, served by deploy/selfhost/sam-dns);
 * - uploads and downloads through the box when no static store key is configured (`object-urls/`).
 */
import { generateCloudInit } from '@simple-agent-manager/cloud-init';
import type { Hono } from 'hono';

import type { Env } from '../env';
import { mountHostedGitRoute } from './hosted-git';
import { hostedGitTokenRoutes } from './hosted-git/token-route';

export { HostedGitRepo } from './hosted-git';
export { BoxUploadGate } from './object-urls';

import { installAnalyticsD1Sink } from './analytics';
import { installBoxDns } from './dns';
import { installBoxObjectUrls, mountBoxObjectRoute } from './object-urls';
import { type SharedWorkerEntry, withReverseTunnel } from './reverse-tunnel/entry';
import { installSpeechEndpoints } from './speech';

const mounted = new WeakSet<object>();

export function withSelfHostBuild<T extends SharedWorkerEntry>(
  worker: T,
  app: Hono<{ Bindings: Env }>
): T {
  if (!mounted.has(app)) {
    mountHostedGitRoute(app);
    app.route('/api/projects', hostedGitTokenRoutes);
    mountBoxObjectRoute(app);
    mounted.add(app);
  }
  installSpeechEndpoints();
  installAnalyticsD1Sink();
  installBoxDns();
  installBoxObjectUrls();
  return withReverseTunnel(worker, generateCloudInit);
}
