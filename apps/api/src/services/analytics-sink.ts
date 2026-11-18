/**
 * Analytics sink seam: where product analytics data points are written and read.
 *
 * On Cloudflare nothing is installed here: writes go to the `ANALYTICS` Analytics Engine binding
 * and the admin routes query Cloudflare's Analytics Engine SQL API, exactly as before. No D1 call
 * and no setting read happens for analytics on Cloudflare.
 *
 * Only the self-host build installs a local sink (`apps/api/src/selfhost/analytics/`, the
 * `analytics_events` table in OBSERVABILITY_DATABASE). The shared Worker entry never imports that
 * module, so the Cloudflare bundle does not contain it. The installed sink decides both sides,
 * writes and reads, from the same `active(env)` answer, so an installation cannot record into one
 * store and read from the other.
 */
import type { Env } from '../env';

/** Where analytics data points go. Same shape as Analytics Engine's `writeDataPoint`. */
export interface AnalyticsSink {
  write(points: AnalyticsEngineDataPoint[]): Promise<void>;
}

export interface LocalAnalyticsSinkExtension {
  /** Whether this installation records and reads analytics locally. Pure: no I/O. */
  active(env: Env): boolean;
  /** The local sink. Called only when `active(env)`. */
  sink(env: Env): AnalyticsSink;
  /** Runs an admin analytics query (Analytics Engine SQL dialect) against the local store. */
  query(env: Env, sql: string): Promise<unknown[]>;
  /** The table name admin queries name in their FROM clause. */
  readonly table: string;
  /** Retention bound, run by the 5-minute observability purge. */
  purge(env: Env): Promise<void>;
}

let extension: LocalAnalyticsSinkExtension | undefined;

/** Called once by the self-host entry, before any request runs. */
export function installLocalAnalyticsSinkExtension(value: LocalAnalyticsSinkExtension): void {
  if (extension && extension !== value) {
    throw new Error('A local analytics sink extension is already installed');
  }
  extension = value;
}

/** Test seam: removes the installed extension. */
export function resetLocalAnalyticsSinkExtensionForTests(): void {
  extension = undefined;
}

/** The installed local sink when it is active here, else undefined. Pure: no I/O. */
export function activeLocalAnalyticsSink(env: Env): LocalAnalyticsSinkExtension | undefined {
  return extension?.active(env) ? extension : undefined;
}

/** The sink for this installation, or null when analytics has nowhere to go (local dev). */
export function resolveAnalyticsSink(env: Env): AnalyticsSink | null {
  const local = activeLocalAnalyticsSink(env);
  if (local) return local.sink(env);
  const dataset = env.ANALYTICS;
  if (!dataset) return null;
  return {
    write: async (points) => {
      for (const point of points) dataset.writeDataPoint(point);
    },
  };
}
