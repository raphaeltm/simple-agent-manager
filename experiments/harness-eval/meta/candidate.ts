/**
 * Candidate versioning types for the meta-evaluation loop.
 *
 * A HarnessCandidate represents a specific configuration of the harness
 * that can be evaluated: which system prompt, model, tool profile, and
 * hyperparameters to use. Candidates are versioned so that eval runs
 * can be compared across configuration changes.
 */

/** Tool profile — which tools are available and how they're configured. */
export interface ToolProfile {
  /** Human-readable profile name (e.g., "full-coding", "read-only") */
  name: string;
  /** Tool names included in this profile */
  tools: string[];
}

/** A single harness configuration to evaluate. */
export interface HarnessCandidate {
  /** Unique version identifier (e.g., "v1", "v2.1", "prompt-rewrite-a") */
  versionId: string;
  /** Human-readable label */
  label: string;
  /** When this candidate was created */
  createdAt: string;
  /** Optional description of what changed from the previous version */
  changeDescription?: string;
  /** The parent version this was derived from (null for the first candidate) */
  parentVersionId?: string;

  /** System prompt text */
  systemPrompt: string;
  /** Model ID to use (e.g., "@cf/google/gemma-4-26b-a4b-it") */
  modelId: string;
  /** Tool profile — which tools are available */
  toolProfile: ToolProfile;
  /** Temperature for LLM sampling */
  temperature: number;
  /** Maximum conversation turns before stopping */
  maxTurns: number;
}

/** Metadata stored alongside a candidate in the registry. */
export interface CandidateMetadata {
  /** Tags for filtering/grouping (e.g., ["prompt-experiment", "gemma"]) */
  tags: string[];
  /** Free-form notes */
  notes?: string;
}

/** A candidate entry in the registry (candidate + metadata). */
export interface CandidateEntry {
  candidate: HarnessCandidate;
  metadata: CandidateMetadata;
}
