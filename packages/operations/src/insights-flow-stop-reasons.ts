/**
 * Why a run stopped before finishing: a small vocabulary derived at read time, never stored
 * (Insights spec, "query the record, don't copy it").
 *
 * A run is a task-mode task (`tasks.task_mode = 'task'`, not an idea). Conversation-mode chats
 * are not runs: a person ending a chat is the normal end of a conversation, and counting those
 * would bury every real blocker (production, 2026-11-16: 168 of 249 conversation tasks ended
 * `cancelled` on purpose).
 *
 * Sources, in the order the rules read them:
 * - an open question on a run that is still going: a session attention marker
 *   (`session_summaries.attention_json`) or an open ask (`asks.source_task_id`);
 * - the task's own terminal record, read only for runs that ended `failed` or `cancelled`
 *   (`terminal_reason`, `provider_limit_wait_json`, `credential_blocked_reason`, and the
 *   `error_message` text the platform writes when it stops a run);
 * - the run's pull requests (`output_pr_url` and owned `task_pull_request_associations`).
 *
 * A run that merged, finished without a pull request, or is still working without a question
 * has no stop reason. The first matching rule wins; the order puts specific causes ahead of the
 * generic "stopped" and "failed" ones, so "Stopped by parent: provider five-hour limit hit" is a
 * usage limit and not a coordinator decision.
 *
 * The error patterns match the messages the platform writes today (audited against production
 * on 2026-11-16). A message no rule recognises falls through to `other_error` for a failed run
 * and `stopped_by_person` for a cancelled one, so a new message is still counted, just less
 * specifically.
 */
import type { FlowStopReason } from '@simple-agent-manager/shared';

/** Columns the rules read, all computed by the run query (`insights-flow-sql.ts`). */
export interface StopReasonColumns {
  /** 1 when the run has not ended (no terminal status). */
  running: string;
  /** 1 when a running run has an open question. */
  waitingOnPerson: string;
  status: string;
  terminalReason: string;
  /** Lower-cased error message, '' when none. */
  err: string;
  /** 1 when the task recorded a provider-limit wait or a blocked credential. */
  limitFlag: string;
  /** 3 merged, 2 open, 1 closed, 0 no pull request: the best state among the run's pull requests. */
  prRank: string;
  /** 1 when one of the run's unmerged pull requests has failing checks. */
  ciFailing: string;
}

const ENDED_WITH_ERROR = (c: StopReasonColumns) => `${c.status} IN ('failed', 'cancelled')`;

function anyLike(column: string, patterns: readonly string[]): string {
  // Code constants only; a quote is doubled so a pattern can name a quoted status.
  return `(${patterns.map((p) => `${column} LIKE '${p.replace(/'/g, "''")}'`).join(' OR ')})`;
}

const NO_MACHINE_PATTERNS = [
  'no capacity%',
  '%placement was refused%',
  'node allocation plan%',
  '%hetzner api%',
  'node boot recovery%',
  "%stuck in 'queued'%",
  '%still queued%',
  '%server limit%',
] as const;
const SETUP_PATTERNS = [
  'workspace build%',
  'workspace did not become ready%',
  '%devcontainer%',
  'failed to populate volume%',
  '%git clone%',
] as const;
const TIME_LIMIT_PATTERNS = ['%ceiling%', '%timed out%'] as const;
const AGENT_STOPPED_PATTERNS = [
  'task runtime is%',
  'agent_prompt_failed%',
  '%no longer live%',
  '%went quiet%',
] as const;

/** The rules, in priority order. Exported so tests can walk every reason. */
export function stopReasonRules(
  c: StopReasonColumns
): ReadonlyArray<{ reason: FlowStopReason | null; when: string }> {
  const errored = ENDED_WITH_ERROR(c);
  return [
    { reason: 'waiting_on_person', when: `${c.running} = 1 AND ${c.waitingOnPerson} = 1` },
    // Still working, or merged: not stopped.
    { reason: null, when: `${c.running} = 1 OR ${c.prRank} = 3` },
    { reason: 'session_expired', when: `${c.terminalReason} = 'snapshot_expired'` },
    { reason: 'no_machine', when: `${errored} AND ${anyLike(c.err, NO_MACHINE_PATTERNS)}` },
    { reason: 'setup_failed', when: `${errored} AND ${anyLike(c.err, SETUP_PATTERNS)}` },
    {
      reason: 'usage_limit',
      when: `${errored} AND (${c.limitFlag} = 1 OR ${c.err} LIKE '%limit%')`,
    },
    { reason: 'ran_too_long', when: `${errored} AND ${anyLike(c.err, TIME_LIMIT_PATTERNS)}` },
    { reason: 'agent_stopped', when: `${errored} AND ${anyLike(c.err, AGENT_STOPPED_PATTERNS)}` },
    {
      reason: 'stopped_by_coordinator',
      when: `${errored} AND ${c.err} LIKE 'stopped by parent%'`,
    },
    { reason: 'ci_failing', when: `${c.ciFailing} = 1` },
    { reason: 'pr_open', when: `${c.prRank} = 2` },
    { reason: 'pr_closed', when: `${c.prRank} = 1` },
    { reason: 'stopped_by_person', when: `${c.status} = 'cancelled'` },
    { reason: 'other_error', when: `${c.status} = 'failed'` },
  ];
}

/** `CASE … END` yielding a `FlowStopReason` or NULL (finished, or still working). */
export function stopReasonCaseSql(c: StopReasonColumns): string {
  const arms = stopReasonRules(c)
    .map(({ reason, when }) => `WHEN ${when} THEN ${reason ? `'${reason}'` : 'NULL'}`)
    .join('\n      ');
  return `CASE\n      ${arms}\n      ELSE NULL END`;
}
