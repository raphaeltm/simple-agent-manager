/**
 * Code-reviewed tables that legitimately shrink between deploys (retention purges, TTL
 * cleanup), so the post-migration row-count gate allows a bounded decrease for them. The
 * Operations telemetry and approval tables are purged daily by
 * `apps/api/src/scheduled/operations-telemetry-retention.ts`. Pull request check
 * observations are pruned by ordinary GitHub webhook traffic when a head commit is replaced
 * or no tracked pull request matches it (`apps/api/src/services/github-pull-request-events.ts`,
 * `packages/operations/src/pull-request-core.ts`); a deploy that applied migration 0254
 * failed on that churn (production run 44010648016, 28243 -> 28201). Its `first_failed_at`
 * column is Insights evidence (first-try CI, flaky checks) that webhooks cannot rebuild, so
 * the bounded decrease here costs Insights history, not correctness.
 * Every other business table keeps zero decrease tolerance. Split out of
 * `d1-migration-safety.ts` (`.claude/rules/18-file-size-limits.md`).
 */
export const DEFAULT_D1_MIGRATION_CHURNING_TABLES = [
  'DATABASE.deployment_releases',
  'DATABASE.diagnostic_reconciliation_state',
  'DATABASE.github_trigger_inbox',
  'DATABASE.github_webhook_deliveries',
  'DATABASE.lifecycle_phase_timings',
  'DATABASE.lifecycle_state_episodes',
  'DATABASE.lifecycle_state_observations',
  'DATABASE.node_lifecycle_decisions',
  'DATABASE.node_log_captures',
  'DATABASE.operations_action_approvals',
  'DATABASE.operations_audit_log',
  'DATABASE.project_files',
  'DATABASE.pull_request_checks',
  'DATABASE.registry_credential_rate_limits',
  'DATABASE.session_snapshot_traces',
  'DATABASE.session_snapshots',
  'DATABASE.sessions',
  'DATABASE.trigger_executions',
  'DATABASE.verifications',
  'DATABASE.vm_provisioning_leases',
  'DATABASE.webhook_deliveries',
  'OBSERVABILITY_DATABASE.platform_errors',
] as const;
export const DEFAULT_D1_MIGRATION_CHURNING_TABLE_MAX_DECREASE_PERCENT = 50;
