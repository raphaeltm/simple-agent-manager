import type { RunReceiptTokens } from './insights-run-usage';

/**
 * The Run receipt (Insights slice R): one read of where a task-backed run's time went, what it
 * produced, which account it ran on, what it used and what slowed it down.
 * `GET /api/projects/:projectId/tasks/:taskId/receipt`, operation `sam_run_receipt`
 * (`packages/operations/src/insights-receipt.ts`). Build spec: idea 01M7HTS38KX2G78JD0ESAGMKKH.
 *
 * Everything is derived at read time from the records SAM already keeps. A value SAM does not
 * measure is reported as missing (`null`, `not_reported`, `not_recorded`), never estimated.
 */

// ---------------------------------------------------------------------------------------------
// ProjectData facts (the one Durable Object read the receipt makes)
// ---------------------------------------------------------------------------------------------

export interface RunReceiptFactsInput {
  sessionId: string;
  /** Window start, epoch ms (the run's agent start). */
  fromMs: number;
  /** Window end, epoch ms; null = up to now. */
  toMs: number | null;
  /** Most messages read in the window to count tool calls. */
  messageScanMaxRows: number;
  waitingMaxIntervals: number;
}

export interface RunReceiptToolKindCount {
  /** ACP tool kind (`execute`, `read`, `edit`, `search`, `fetch`, `think`, `other`, ...). */
  kind: string;
  count: number;
}

export interface RunReceiptWaitingInterval {
  startMs: number;
  /** Null while the question is still open. */
  endMs: number | null;
  /** The agent's question: untrusted agent text, possibly long. */
  reason: string | null;
}

export interface RunReceiptFacts {
  /** False when the chat does not exist in this project's object. */
  sessionFound: boolean;
  /** True when the chat's messages were moved to archive storage, so tool calls cannot be counted. */
  messagesArchived: boolean;
  /** The chat's ACP sessions, newest first (`acp_sessions.chat_session_id`). */
  acpSessionIds: string[];
  toolCalls: {
    byKind: RunReceiptToolKindCount[];
    total: number;
    /** Messages read in the window (at most the cap). */
    examinedMessages: number;
    scanLimited: boolean;
  };
  waitingIntervals: RunReceiptWaitingInterval[];
  /** True when more questions fell in the window than were returned. */
  waitingLimited: boolean;
  /** Last assistant or tool message in the window. */
  lastAgentMessageAt: number | null;
  /** Last message of any role in the window. */
  lastMessageAt: number | null;
}

// ---------------------------------------------------------------------------------------------
// The receipt
// ---------------------------------------------------------------------------------------------

/** The phases of a run, in the order they happen. */
export type RunReceiptPhaseKey = 'machine' | 'setup' | 'agent' | 'waiting' | 'ci';

export const RUN_RECEIPT_PHASE_KEYS: readonly RunReceiptPhaseKey[] = [
  'machine',
  'setup',
  'agent',
  'waiting',
  'ci',
];

export interface RunReceiptPhase {
  key: RunReceiptPhaseKey;
  /** Null when SAM has no record to measure this phase from. */
  durationMs: number | null;
  /** True when the read stopped at a cap, so the duration is a floor. */
  limited?: boolean;
}

/** A part of the receipt that could not be read; the rest is still returned. */
export type RunReceiptSection =
  | 'outcome'
  | 'toolCalls'
  | 'waiting'
  | 'comparison'
  | 'account'
  | 'tokens';

export interface RunReceiptPullRequest {
  number: number;
  url: string;
  title: string | null;
  repository: string;
  state: 'open' | 'closed' | 'merged';
  mergedAt: string | null;
}

export type RunReceiptCiFirstTry = 'passed' | 'failed' | 'pending' | 'not_recorded';

export interface RunReceiptOutcome {
  pullRequest: RunReceiptPullRequest | null;
  /** Check state on the pull request's latest head; null without a pull request or checks. */
  checks: 'success' | 'failure' | 'pending' | 'neutral' | null;
  /**
   * Whether CI passed on the pull request's opening commit, by the same rule as Insights · Flow
   * (`firstTryVerdictSql`, `packages/operations/src/insights-flow-sql.ts`). `pending` while checks
   * run or when none reported; `not_recorded` when there is no pull request, or SAM did not see it
   * from its first commit (`pull_request_heads.from_open`).
   */
  ciFirstTry: RunReceiptCiFirstTry;
  terminalReason: string | null;
}

export interface RunReceiptAccount {
  agentType: string | null;
  /** Who owns the credential: `user`, `project` or `platform`. */
  credentialSource: string | null;
  /** Which tier chose it: `run`, `profile`, `project`, `user` or `platform`. */
  credentialScope: string | null;
  /** The account's name, shown only to the person who ran the session. */
  accountName: string | null;
  isOwnSession: boolean;
}

export interface RunReceiptResources {
  /** False when no resource history was recorded for the run (Instant runs record none). */
  measured: boolean;
  peakMemoryBytes: number | null;
  requestedMemoryMb: number | null;
  peakCpuMillis: number | null;
  requestedCpuMillis: number | null;
  oomKills: number;
}

export interface RunReceiptToolCalls {
  total: number;
  byKind: RunReceiptToolKindCount[];
  /** True when the run had more messages than one receipt reads; counts are a floor. */
  scanLimited: boolean;
}

/** Why something is on the "What slowed it down" list. */
export type RunReceiptSlowKind = 'machine' | 'setup' | 'waiting' | 'ci_failing' | 'memory' | 'oom';

export interface RunReceiptSlowItem {
  kind: RunReceiptSlowKind;
  durationMs: number | null;
  /** The usual duration for the same skill or profile in this project, when compared. */
  usualMs: number | null;
  comparedBy: 'skill' | 'profile' | null;
  /** Runs the usual duration was taken from. */
  sampleSize: number | null;
  /** The agent's question for a `waiting` item: untrusted agent text, truncated. */
  question: string | null;
  peakMemoryBytes: number | null;
  requestedMemoryMb: number | null;
  count: number | null;
}

export interface RunReceipt {
  projectId: string;
  taskId: string;
  sessionId: string | null;
  title: string;
  status: string;
  /** True while the run can still change (not completed, failed or cancelled). */
  live: boolean;
  createdAt: string;
  /** End of the measured window, ISO. */
  endedAt: string;
  totalMs: number;
  phases: RunReceiptPhase[];
  outcome: RunReceiptOutcome;
  account: RunReceiptAccount | null;
  resources: RunReceiptResources;
  /** Null when tool calls could not be counted (archived or unavailable). */
  toolCalls: RunReceiptToolCalls | null;
  /** Measured token usage per model (slice U), or `not_reported`; never estimated. */
  tokens: RunReceiptTokens;
  /** Up to three, largest delay first. */
  slowedDown: RunReceiptSlowItem[];
  unavailable: RunReceiptSection[];
  generatedAt: string;
}
