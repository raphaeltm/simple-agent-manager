/**
 * The self-host build's analytics store: product analytics in OBSERVABILITY_DATABASE, for a
 * runtime without Workers Analytics Engine. Imported only by the self-host entry, which calls
 * `installAnalyticsD1Sink()` once before any request; the shared Worker entry (`src/index.ts`)
 * never imports this directory, so the Cloudflare bundle does not contain it.
 *
 * The sink is active only when the deployment also sets `ANALYTICS_SINK="d1"` and binds
 * OBSERVABILITY_DATABASE, whose migration projection includes
 * `SELFHOST_OBSERVABILITY_MIGRATIONS` (../observability-migrations.ts).
 */
import { installAdminSettingDefinitions } from '../../services/admin-settings-registry';
import {
  installLocalAnalyticsSinkExtension,
  type LocalAnalyticsSinkExtension,
} from '../../services/analytics-sink';
import {
  ANALYTICS_EVENTS_TABLE,
  analyticsD1Sink,
  isAnalyticsD1SinkEnabled,
  purgeAnalyticsEvents,
  queryAnalyticsD1,
} from './d1-sink';
import { ANALYTICS_D1_SETTINGS } from './settings';

export const analyticsD1SinkExtension: LocalAnalyticsSinkExtension = {
  table: ANALYTICS_EVENTS_TABLE,
  active: (env) => isAnalyticsD1SinkEnabled(env),
  sink: (env) => analyticsD1Sink(env.OBSERVABILITY_DATABASE),
  query: (env, sql) => queryAnalyticsD1(env.OBSERVABILITY_DATABASE, sql),
  purge: async (env) => {
    await purgeAnalyticsEvents(env);
  },
};

/** Registers the retention settings and the D1 sink. Idempotent; call before any request. */
export function installAnalyticsD1Sink(): void {
  installAdminSettingDefinitions(ANALYTICS_D1_SETTINGS);
  installLocalAnalyticsSinkExtension(analyticsD1SinkExtension);
}
