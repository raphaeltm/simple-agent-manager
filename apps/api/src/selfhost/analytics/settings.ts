/**
 * Retention bounds for the self-host D1 analytics sink. Only the self-host entry registers these
 * (`installAnalyticsD1Sink`), so a Cloudflare admin never sees them: Cloudflare keeps analytics in
 * Analytics Engine, whose retention Cloudflare manages.
 */
import {
  type AdminSettingDefinition,
  type AdminSettingName,
  integerDefinition,
} from '../../services/admin-setting-definitions';

/** The longest admin analytics period is 90 days, so this keeps every period complete. */
export const DEFAULT_ANALYTICS_D1_RETENTION_DAYS = 90;
/** At most ~1.3 KB per row (blob lengths are capped), so about 650 MB worst case. */
export const DEFAULT_ANALYTICS_D1_MAX_ROWS = 500_000;

/** These names exist only in the self-host build, so they are not in the shared name union. */
export const ANALYTICS_D1_RETENTION_DAYS_SETTING = 'analytics.d1.retentionDays' as AdminSettingName;
export const ANALYTICS_D1_MAX_ROWS_SETTING = 'analytics.d1.maxRows' as AdminSettingName;

export const ANALYTICS_D1_SETTINGS: readonly AdminSettingDefinition[] = [
  integerDefinition(
    ANALYTICS_D1_RETENTION_DAYS_SETTING,
    DEFAULT_ANALYTICS_D1_RETENTION_DAYS,
    'Operations',
    'Days of product analytics events kept in the installation database (the longest admin analytics period is 90).',
    { min: 1, max: 365 }
  ),
  integerDefinition(
    ANALYTICS_D1_MAX_ROWS_SETTING,
    DEFAULT_ANALYTICS_D1_MAX_ROWS,
    'Operations',
    'Most product analytics event rows kept in the installation database; the oldest above this are deleted (500,000 is about 650 MB worst case).',
    { min: 1, max: 10_000_000 }
  ),
];
