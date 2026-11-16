/** Content-free, fixed-cardinality diagnostics. Never persisted to SQLite. */
export const INGEST_ROLES = [
  'user',
  'assistant',
  'thinking',
  'tool',
  'plan',
  'system',
  'other',
] as const;
export type IngestRole = (typeof INGEST_ROLES)[number];
export type MergeRefusal =
  | 'setting_disabled'
  | 'legacy_client'
  | 'missing_incarnation'
  | 'invalid_sequence'
  | 'retired_source'
  | 'receipt_cap';
export type MergeBreak =
  | 'no_open'
  | 'source'
  | 'turn'
  | 'intervening_writer'
  | 'materialized'
  | 'role'
  | 'metadata'
  | 'origin'
  | 'sequence_gap'
  | 'timestamp'
  | 'out_of_order'
  | 'size_cap';
type RoleCounts = Record<IngestRole, number>;
const roles = (): RoleCounts =>
  Object.fromEntries(INGEST_ROLES.map((role) => [role, 0])) as RoleCounts;
function roleKey(role: string): IngestRole {
  return INGEST_ROLES.includes(role as IngestRole) ? (role as IngestRole) : 'other';
}
export interface MessageIngestMetrics {
  batches: number;
  received: RoleCounts;
  accepted: RoleCounts;
  inserted: RoleCounts;
  eligible: number;
  coalesced: number;
  appendStatements: number;
  duplicates: number;
  mergeReadyBatches: number;
  refused: Partial<Record<MergeRefusal, number>>;
  breaks: Partial<Record<MergeBreak, number>>;
  legacyProjectSocketsMax: number;
  legacySessionSocketsMax: number;
}
export function emptyMessageIngestMetrics(): MessageIngestMetrics {
  return {
    batches: 0,
    received: roles(),
    accepted: roles(),
    inserted: roles(),
    eligible: 0,
    coalesced: 0,
    appendStatements: 0,
    duplicates: 0,
    mergeReadyBatches: 0,
    refused: {},
    breaks: {},
    legacyProjectSocketsMax: 0,
    legacySessionSocketsMax: 0,
  };
}
export function countIngestRole(counts: RoleCounts, role: string): void {
  counts[roleKey(role)]++;
}
/** A batch has one primary refusal; run boundaries are counted separately. */
export function refuseMerge(metrics: MessageIngestMetrics | undefined, reason: MergeRefusal): void {
  if (metrics && Object.keys(metrics.refused).length === 0) metrics.refused[reason] = 1;
}
export function breakMerge(metrics: MessageIngestMetrics | undefined, reason: MergeBreak): void {
  if (metrics) metrics.breaks[reason] = (metrics.breaks[reason] ?? 0) + 1;
}
export function addMessageIngestMetrics(
  total: MessageIngestMetrics,
  batch: MessageIngestMetrics
): void {
  for (const field of ['received', 'accepted', 'inserted'] as const)
    for (const role of INGEST_ROLES) total[field][role] += batch[field][role];
  for (const field of [
    'batches',
    'eligible',
    'coalesced',
    'appendStatements',
    'duplicates',
    'mergeReadyBatches',
  ] as const)
    total[field] += batch[field];
  for (const [key, value] of Object.entries(batch.refused)) {
    const reason = key as MergeRefusal;
    total.refused[reason] = (total.refused[reason] ?? 0) + value;
  }
  for (const [key, value] of Object.entries(batch.breaks)) {
    const reason = key as MergeBreak;
    total.breaks[reason] = (total.breaks[reason] ?? 0) + value;
  }
  total.legacyProjectSocketsMax = Math.max(
    total.legacyProjectSocketsMax,
    batch.legacyProjectSocketsMax
  );
  total.legacySessionSocketsMax = Math.max(
    total.legacySessionSocketsMax,
    batch.legacySessionSocketsMax
  );
}
