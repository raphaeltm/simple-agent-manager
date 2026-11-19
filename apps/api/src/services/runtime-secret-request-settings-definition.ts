/**
 * Bounds for agent-requested runtime secrets (`runtime-secret-requests.ts`), editable in
 * Admin → Settings ("Chat" category). Definitions only, with no imports, so the admin settings
 * registry and the resolver in `runtime-secret-request-settings.ts` can both depend on it.
 */
export const RUNTIME_SECRET_REQUEST_SETTINGS = [
  {
    name: 'secrets.requestLifetimeMinutes',
    defaultValue: 1_440,
    description:
      'Minutes an agent secret request stays open for a person to supply the value. After that it expires and the agent is told.',
    range: { min: 5, max: 10_080 },
  },
  {
    name: 'secrets.minTtlSeconds',
    defaultValue: 60,
    description: 'Shortest lifetime an agent may ask for a collected secret, in seconds.',
    range: { min: 10, max: 3_600 },
  },
  {
    name: 'secrets.maxTtlSeconds',
    defaultValue: 2_592_000,
    description:
      'Longest lifetime an agent may ask for a collected secret, in seconds. A request with no lifetime keeps the value until someone deletes it.',
    range: { min: 60, max: 31_536_000 },
  },
  {
    name: 'secrets.maxPendingPerSession',
    defaultValue: 10,
    description: 'Most open secret requests one chat session may have at a time.',
    range: { min: 1, max: 100 },
  },
  {
    name: 'secrets.historyRetentionDays',
    defaultValue: 30,
    description:
      'Days a finished secret request (supplied, declined or expired) is kept before the daily purge deletes its record. Values it stored are not affected.',
    range: { min: 1, max: 365 },
  },
  {
    name: 'secrets.sweepBatchSize',
    defaultValue: 50,
    description:
      'Expired collected values or old request records one daily purge statement deletes. The purge repeats batches until done or out of time.',
    // Deletes bind one id per row plus one reserved bind; D1 caps a statement at 100 binds.
    range: { min: 1, max: 90 },
  },
  {
    name: 'secrets.purgeBudgetSeconds',
    defaultValue: 20,
    description: 'Seconds the daily purge of expired secret values and old requests may run.',
    range: { min: 1, max: 120 },
  },
  {
    name: 'secrets.expirySweepBatchSize',
    defaultValue: 10,
    description:
      'Expired or unnotified secret requests one five-minute sweep handles. Each one tells its agent, so this bounds the work per sweep.',
    range: { min: 1, max: 25 },
  },
  {
    name: 'secrets.notifyRetryMinutes',
    defaultValue: 60,
    description:
      'Minutes after a request is answered or expires during which the sweep retries telling the agent if the first notice could not be queued.',
    // At least three five-minute sweeps, so a failure just before a sweep still gets a retry.
    range: { min: 15, max: 1_440 },
  },
] as const;

export type RuntimeSecretRequestSettingName =
  (typeof RUNTIME_SECRET_REQUEST_SETTINGS)[number]['name'];
