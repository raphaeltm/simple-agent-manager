/**
 * Code-reviewed tables that legitimately shrink between deploys (retention purges, TTL
 * cleanup), so the post-migration row-count gate allows a bounded decrease for them.
 * Every other business table keeps zero decrease tolerance. Split out of
 * `d1-migration-safety.ts` (`.claude/rules/18-file-size-limits.md`).
 */
export const DEFAULT_D1_MIGRATION_CHURNING_TABLES = [
  'DATABASE.deployment_releases',
  'DATABASE.diagnostic_reconciliation_state',
  'DATABASE.github_trigger_inbox',
  'DATABASE.github_webhook_deliveries',
  'DATABASE.lifecycle_state_episodes',
  'DATABASE.lifecycle_state_observations',
  'DATABASE.operations_audit_log',
  'DATABASE.project_files',
  'DATABASE.registry_credential_rate_limits',
  'DATABASE.session_snapshots',
  'DATABASE.sessions',
  'DATABASE.trial_waitlist',
  'DATABASE.trigger_executions',
  'DATABASE.verifications',
  'DATABASE.vm_provisioning_leases',
  'DATABASE.webhook_deliveries',
  'OBSERVABILITY_DATABASE.platform_errors',
] as const;
export const DEFAULT_D1_MIGRATION_CHURNING_TABLE_MAX_DECREASE_PERCENT = 50;
