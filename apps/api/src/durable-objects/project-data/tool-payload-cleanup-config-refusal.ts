import type { StorageSafetyConfig } from './storage-safety';

/**
 * The two CONFIGURATION gates that stop an enabled tool-payload cleanup from producing a plan,
 * expressed once so the gate and its diagnostic cannot drift apart.
 *
 * ## Why this module exists
 *
 * On 2026-09-14 production carried `PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_CUTOFF_CREATED_AT` and
 * `_PLAN_ID` from a one-shot P0 plan whose manifest was never wired up: `_MANIFEST_KEY`,
 * `_MANIFEST_SHA256` and all four `_MAX_TOTAL_*` ceilings were empty strings. A non-null cutoff
 * ARMS the strict approved-manifest gate, so the gate refused on every alarm and
 * `createToolPayloadCleanupPlan` returned `null` — silently, with no log line anywhere.
 *
 * Setting `PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_ENABLED=true` on top of that config would have
 * deployed a flag whose value reads `true` from the Cloudflare API while the feature did
 * nothing, and the only symptom would have been the absence of reclaim. That is the same class
 * of invisible failure as the eleven-day GitHub Environment override that kept the flag off in
 * the first place (`.claude/rules/70-flag-flips-must-verify-the-deployed-value.md`), one layer
 * down: a signal that says "on" standing in for the condition "this will actually run".
 *
 * ## Configuration refusal vs. operational refusal
 *
 * Only operator-configuration mistakes belong here. The later returns in
 * `createToolPayloadCleanupPlan` — a pending recheck window, a database already under the target
 * ratio, retention not yet due — are the feature working correctly and must stay quiet.
 *
 * @see .claude/rules/74-proxy-signals-must-match-the-condition.md
 */
export type ToolPayloadCleanupConfigRefusal = {
  /**
   * `manifest_without_fixed_cutoff` — a manifest key or hash is present but the fixed cutoff that
   * gates the approved-plan branch is not, so the strict block would be skipped entirely.
   *
   * `approved_plan_incomplete` — the fixed cutoff armed the approved-plan branch but at least one
   * of its requirements is unmet.
   */
  gate: 'manifest_without_fixed_cutoff' | 'approved_plan_incomplete';
  /** Stable requirement names, safe to log: no secrets and no payload content. */
  unmet: string[];
};

type ToolPayloadCleanupConfigFields = Pick<
  StorageSafetyConfig,
  | 'toolPayloadCleanupCutoffCreatedAt'
  | 'toolPayloadCleanupExactConfigValid'
  | 'toolPayloadCleanupManifestKey'
  | 'toolPayloadCleanupManifestSha256'
  | 'toolPayloadCleanupMaxTotalBytes'
  | 'toolPayloadCleanupMaxTotalR2Operations'
  | 'toolPayloadCleanupMaxTotalRows'
  | 'toolPayloadCleanupMaxTotalWallTimeMs'
  | 'toolPayloadCleanupPlanId'
  | 'toolPayloadCleanupProjectIds'
>;

/**
 * Returns the configuration refusal for `projectId`, or `null` when configuration permits a plan.
 *
 * This function IS the gate — `createToolPayloadCleanupPlan` refuses exactly when this returns a
 * value. Keeping one expression of the rule is deliberate: a separate "explain why" helper that
 * mirrored the conditions would drift from them, which is how the archive sweep's two
 * independently configured message ceilings deadlocked production for four days on 2026-09-08.
 */
export function describeToolPayloadCleanupConfigRefusal(
  projectId: string,
  config: ToolPayloadCleanupConfigFields,
  hasTransactionSync: boolean
): ToolPayloadCleanupConfigRefusal | null {
  const fixedCutoffConfigured = config.toolPayloadCleanupCutoffCreatedAt !== null;

  // An approved-manifest plan is ONLY ever entered through the fixed-cutoff gate below. Without
  // this guard, half-applied operator config — manifest key/hash and ceilings set, but
  // `PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_CUTOFF_CREATED_AT` dropped — would skip the strict block
  // entirely (including the exact single-project allowlist match) and still take the manifest
  // branch for EVERY project, with only an incidental cutoff-timestamp mismatch standing between
  // it and a strip.
  if (
    (config.toolPayloadCleanupManifestKey || config.toolPayloadCleanupManifestSha256) &&
    !fixedCutoffConfigured
  ) {
    return { gate: 'manifest_without_fixed_cutoff', unmet: ['cutoffCreatedAt'] };
  }

  if (!fixedCutoffConfigured) return null;

  const unmet: string[] = [];
  if (!config.toolPayloadCleanupExactConfigValid) unmet.push('exactConfigValid');
  if (config.toolPayloadCleanupCutoffCreatedAt === -1) unmet.push('cutoffCreatedAt');
  if (!config.toolPayloadCleanupPlanId) unmet.push('planId');
  if (!config.toolPayloadCleanupManifestKey) unmet.push('manifestKey');
  if (!config.toolPayloadCleanupManifestSha256) unmet.push('manifestSha256');
  else if (!/^[a-f0-9]{64}$/.test(config.toolPayloadCleanupManifestSha256)) {
    unmet.push('manifestSha256Format');
  }
  if (config.toolPayloadCleanupMaxTotalRows === null) unmet.push('maxTotalRows');
  if (config.toolPayloadCleanupMaxTotalBytes === null) unmet.push('maxTotalBytes');
  if (config.toolPayloadCleanupMaxTotalR2Operations === null) unmet.push('maxTotalR2Operations');
  if (config.toolPayloadCleanupMaxTotalWallTimeMs === null) unmet.push('maxTotalWallTimeMs');
  if (!hasTransactionSync) unmet.push('transactionSync');
  if (config.toolPayloadCleanupProjectIds?.length !== 1) unmet.push('projectIdsExactlyOne');
  else if (config.toolPayloadCleanupProjectIds[0] !== projectId) unmet.push('projectIdsMatch');

  return unmet.length > 0 ? { gate: 'approved_plan_incomplete', unmet } : null;
}

/**
 * Whether `projectId` is in scope for tool-payload cleanup at all.
 *
 * `PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_PROJECT_IDS` unset means "every project"; set means exactly
 * the listed ones. An operator-initiated run (`forceStart`) is an explicit request for this
 * project and bypasses the allowlist, which is why the admin route can clean a project the
 * automatic sweep would skip.
 *
 * Shared deliberately: `createToolPayloadCleanupPlan` uses it to decide whether to RUN, and
 * `shouldReportToolPayloadCleanupConfigRefusal` uses it to decide whether to WARN. Two copies of
 * the same predicate would drift into warning about projects that are not in scope, or staying
 * silent about ones that are — and a warning that does not track the thing it describes is worse
 * than no warning.
 */
export function isProjectInToolPayloadCleanupScope(
  projectId: string,
  projectIds: string[] | null,
  forceStart: boolean
): boolean {
  if (forceStart) return true;
  return projectIds === null || projectIds.includes(projectId);
}

/**
 * Whether a refusal for `projectId` is worth a log line.
 *
 * `createToolPayloadCleanupPlan` runs on every storage alarm of every ProjectData object, so an
 * unbounded warn here would trade a silent no-op for an unreadable log. Two bounds apply, and
 * they are NOT equally strong:
 *
 * - **Cadence — always applies.** `allowStart` is set only on the tick where the storage
 *   measurement ran, which `PROJECT_DATA_STORAGE_MEASURE_INTERVAL_MS` holds to once an hour per
 *   object. `forceStart` marks an operator-initiated run, which is low volume and is exactly
 *   when the answer is wanted.
 * - **Scope — applies only when an allowlist is configured.** A project outside
 *   `PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_PROJECT_IDS` is refused by the allowlist anyway, so its
 *   `projectIdsMatch` failure is expected rather than a misconfiguration. When that var is
 *   unset there is no allowlist to be outside of, so this bound does nothing and EVERY object
 *   reports on its own hourly tick.
 *
 * The unscoped case is deliberate, not an oversight: a half-applied config with no allowlist is
 * installation-wide breakage, and per-object-per-hour is the right volume for that. It matters
 * most for `manifest_without_fixed_cutoff`, which cannot consult the allowlist at all — that
 * gate fires before the approved-plan block that would have required a single-project match. So
 * the worst case is one line per active ProjectData object per hour, for as long as an operator
 * leaves a manifest key set with no cutoff. Bounded, and loud on purpose.
 *
 * This governs logging only. The refusal itself is returned unconditionally.
 */
export function shouldReportToolPayloadCleanupConfigRefusal(
  projectId: string,
  projectIds: string[] | null,
  options: { allowStart?: boolean; forceStart?: boolean }
): boolean {
  if (!options.allowStart && !options.forceStart) return false;
  return isProjectInToolPayloadCleanupScope(projectId, projectIds, options.forceStart === true);
}
