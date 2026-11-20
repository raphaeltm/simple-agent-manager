import type { runDebugDiagnosis } from '../debug-agent';
import type {
  IdeaWorkSnapshotReader,
  IncidentReopenEvidence,
} from '../platform-feedback-incidents';

export type FeedbackTriageTrigger = 'cron' | 'manual';
export interface FeedbackTriageResult {
  enabled: boolean;
  trigger: FeedbackTriageTrigger;
  groupsFound: number;
  ideasCreated: number;
  ideasUpdated: number;
  groupsSkipped: number;
  groupsFailed: number;
  groupsBudgetDeferred: number;
  /** Watched incidents whose recurrence was recorded (counts only, no re-triage). */
  watchedRecurrences: number;
  /** Watched incidents a spike returned to the triage queue. */
  watchedEscalated: number;
  /** Watched incidents expired after the quiet period; undefined when that step failed. */
  watchedExpired: number | undefined;
  failureReasons: string[];
}
export interface ErrorRow {
  id: string;
  source: string;
  level?: string | null;
  message: string;
  timestamp: number;
  task_id?: string | null;
  node_id?: string | null;
  nodeAgentVersion?: string | null;
}
export type FeedbackSeverity = 'error' | 'warn';
export interface FeedbackErrorEvidence extends IncidentReopenEvidence {
  errorId: string;
  nodeId?: string;
}
export interface FeedbackOccurrence {
  id: string;
  timestamp: number;
}
export interface FeedbackErrorGroup {
  signature: string;
  canonicalSignature?: string;
  legacySignatures?: string[];
  source: string;
  severity: FeedbackSeverity;
  summary: string;
  /** Redacted, normalized message in original case; absent for groups rebuilt from storage. */
  message?: string;
  firstSeenAt: number;
  lastSeenAt: number;
  evidence: FeedbackErrorEvidence[];
  count: number;
  /**
   * Id and timestamp of every error in this window (bounded by the triage error limit).
   * Watched incidents count each id once; absent for groups rebuilt from storage.
   */
  occurrences?: FeedbackOccurrence[];
}
export interface ExistingTriagePriorityRow {
  signature: string;
  canonical_signature?: string | null;
  source: string | null;
  diagnosis_id: string | null;
  idea_id: string | null;
  occurrence_count: number;
  severity: string | null;
  budget_deferred_until: number | null;
  rejected_at: number | null;
  queue_state: string | null;
  resolved_at: number | null;
  resolved_by_task_id: string | null;
  resolved_task_output_pr_url: string | null;
  resolution_note: string | null;
  resolution_references: string | null;
  expired_at: number | null;
}
export interface StoredTriageGroupRow {
  signature: string;
  source: string;
  summary: string;
  severity: string | null;
  first_seen_at: number;
  last_seen_at: number;
  occurrence_count: number;
  evidence_refs: string;
}
export interface TriageDeps {
  now?: () => number;
  diagnose?: typeof runDebugDiagnosis;
  /** Durable Object link/note reader; defaults to the real ProjectData read. */
  readEngagement?: IdeaWorkSnapshotReader;
}
