/**
 * Cron handler for analytics event forwarding (Phase 4).
 *
 * Runs daily at 03:00 UTC to forward conversion events from
 * Analytics Engine to external platforms (Segment, GA4).
 */
import type { Env } from '../index';
import { type ForwardResult,runAnalyticsForward } from '../services/analytics-forward';

export async function runAnalyticsForwardJob(env: Env): Promise<ForwardResult> {
  return runAnalyticsForward(env);
}
