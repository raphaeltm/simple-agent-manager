// =============================================================================
// Trigger Defaults (all configurable via environment variables)
// Per Constitution Principle XI: no hardcoded values — all limits must be configurable.
// =============================================================================

/** Maximum triggers per project. Override via MAX_TRIGGERS_PER_PROJECT env var. */
export const DEFAULT_MAX_TRIGGERS_PER_PROJECT = 10;

/** Minimum interval between cron fires in minutes. Override via CRON_MIN_INTERVAL_MINUTES env var. */
export const DEFAULT_CRON_MIN_INTERVAL_MINUTES = 15;

/** Maximum triggers to fire per cron sweep. Override via CRON_MAX_FIRE_PER_SWEEP env var. */
export const DEFAULT_CRON_MAX_FIRE_PER_SWEEP = 5;

/** Maximum prompt template length in characters. Override via CRON_TEMPLATE_MAX_LENGTH env var. */
export const DEFAULT_CRON_TEMPLATE_MAX_LENGTH = 8000;

/** Maximum length for a single interpolated field value. Override via CRON_TEMPLATE_MAX_FIELD_LENGTH env var. */
export const DEFAULT_CRON_TEMPLATE_MAX_FIELD_LENGTH = 2000;

/** Days to retain trigger execution logs. Override via TRIGGER_EXECUTION_LOG_RETENTION_DAYS env var. */
export const DEFAULT_TRIGGER_EXECUTION_LOG_RETENTION_DAYS = 90;

/** Default max concurrent executions per trigger. Override via TRIGGER_DEFAULT_MAX_CONCURRENT env var. */
export const DEFAULT_TRIGGER_DEFAULT_MAX_CONCURRENT = 1;

/** Auto-pause trigger after this many consecutive failures. Override via TRIGGER_AUTO_PAUSE_AFTER_FAILURES env var. */
export const DEFAULT_TRIGGER_AUTO_PAUSE_AFTER_FAILURES = 3;

/** Maximum length for a trigger name. Override via TRIGGER_NAME_MAX_LENGTH env var. */
export const DEFAULT_TRIGGER_NAME_MAX_LENGTH = 100;

/** Maximum length for a trigger description. Override via TRIGGER_DESCRIPTION_MAX_LENGTH env var. */
export const DEFAULT_TRIGGER_DESCRIPTION_MAX_LENGTH = 500;

/** All trigger defaults aggregated for convenience. */
export const TRIGGER_DEFAULTS = {
  MAX_TRIGGERS_PER_PROJECT: DEFAULT_MAX_TRIGGERS_PER_PROJECT,
  CRON_MIN_INTERVAL_MINUTES: DEFAULT_CRON_MIN_INTERVAL_MINUTES,
  CRON_MAX_FIRE_PER_SWEEP: DEFAULT_CRON_MAX_FIRE_PER_SWEEP,
  CRON_TEMPLATE_MAX_LENGTH: DEFAULT_CRON_TEMPLATE_MAX_LENGTH,
  CRON_TEMPLATE_MAX_FIELD_LENGTH: DEFAULT_CRON_TEMPLATE_MAX_FIELD_LENGTH,
  TRIGGER_EXECUTION_LOG_RETENTION_DAYS: DEFAULT_TRIGGER_EXECUTION_LOG_RETENTION_DAYS,
  TRIGGER_DEFAULT_MAX_CONCURRENT: DEFAULT_TRIGGER_DEFAULT_MAX_CONCURRENT,
  TRIGGER_AUTO_PAUSE_AFTER_FAILURES: DEFAULT_TRIGGER_AUTO_PAUSE_AFTER_FAILURES,
  TRIGGER_NAME_MAX_LENGTH: DEFAULT_TRIGGER_NAME_MAX_LENGTH,
  TRIGGER_DESCRIPTION_MAX_LENGTH: DEFAULT_TRIGGER_DESCRIPTION_MAX_LENGTH,
} as const;
