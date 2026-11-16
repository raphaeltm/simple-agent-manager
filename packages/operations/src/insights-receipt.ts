/**
 * Run receipt (Insights slice R): one task-backed run's phases, outcome, account, resources,
 * tool calls and what slowed it down. Shared by REST (`GET .../tasks/:taskId/receipt`), the SAM
 * Connector (catalog operation `sam_run_receipt`) and, with slice I, sam-mcp. Build spec: idea
 * 01M7HTS38KX2G78JD0ESAGMKKH. Arithmetic lives in `insights-receipt-compute.ts`.
 *
 * Round trips (`.claude/rules/60`, receipt budget 8): authorization (1), settings (1, cached per
 * isolate), the task read (1), then in parallel the pull request (≤1), the ProjectData facts
 * (≤1) and the comparable runs (≤1), and the account name for the person who ran it (≤1).
 * At most 7.
 *
 * Scope: every statement binds `project_id` (rule 11). A task in another project and a task that
 * does not exist return the same not-found. Child tables without a project column
 * (`task_status_events`, `agent_sessions`) are reached only through a project-scoped parent.
 */
import {
  type RunReceipt,
  type RunReceiptSection,
  TASK_TERMINAL_STATUSES,
} from '@simple-agent-manager/shared';
import { log } from '@simple-agent-manager/worker-core';

import { authorizeProjectOperation } from './authorization';
import { OperationError } from './errors';
import { computePhases, slowedDown, timestampMs } from './insights-receipt-compute';
import {
  AskSchema,
  earliest,
  julianDayMs,
  parseJsonList,
  readAccount,
  readPullRequest,
  readResources,
  readTask,
  readUsual,
  reservationOf,
} from './insights-receipt-reads';
import { getInsightsReceiptLimits } from './insights-receipt-settings';
import type { OperationContext } from './types';

/** Run one part of the receipt; a failure empties that part and names it, not the receipt. */
async function part<T>(
  name: RunReceiptSection,
  context: { projectId: string; taskId: string },
  fallback: T,
  read: () => Promise<T>,
  unavailable: RunReceiptSection[]
): Promise<T> {
  try {
    return await read();
  } catch (error) {
    log.error('insights_receipt.section_failed', {
      ...context,
      section: name,
      error: error instanceof Error ? error.message : String(error),
      action: 'section_unavailable',
    });
    unavailable.push(name);
    return fallback;
  }
}

export interface RunReceiptInput {
  projectId: string;
  taskId: string;
}

export async function runReceipt(
  ctx: OperationContext,
  input: RunReceiptInput
): Promise<RunReceipt> {
  const projectId = typeof input.projectId === 'string' ? input.projectId.trim() : '';
  const taskId = typeof input.taskId === 'string' ? input.taskId.trim() : '';
  await authorizeProjectOperation(ctx, projectId);
  if (!taskId) throw new OperationError('not_found', 'Task not found');

  const [limits, row] = await Promise.all([
    getInsightsReceiptLimits(ctx),
    readTask(ctx, projectId, taskId),
  ]);
  if (!row) throw new OperationError('not_found', 'Task not found');

  const now = Date.now();
  const context = { projectId, taskId };
  const live = !(TASK_TERMINAL_STATUSES as readonly string[]).includes(row.status);
  const createdAt = timestampMs(row.created_at) ?? now;
  const machineReadyAt = earliest(
    timestampMs(row.creating_started_at),
    julianDayMs(row.delegated_jd)
  );
  const agentStartAt = julianDayMs(row.in_progress_jd) ?? timestampMs(row.started_at);
  const completedAt = live ? null : timestampMs(row.completed_at);
  const sessionId = row.chat_session_id ?? row.workspace_session_id ?? null;
  const unavailable: RunReceiptSection[] = [];

  const [pullRequest, facts, usual] = await Promise.all([
    part('outcome', context, null, () => readPullRequest(ctx, projectId, row), unavailable),
    sessionId && agentStartAt !== null
      ? part(
          'toolCalls',
          context,
          null,
          () =>
            ctx.ports.projectData.getRunReceiptFacts(projectId, {
              sessionId,
              fromMs: agentStartAt,
              toMs: completedAt,
              messageScanMaxRows: limits.receiptMessageScanMaxRows,
              waitingMaxIntervals: limits.receiptWaitingMaxQuestions,
            }),
          unavailable
        )
      : Promise.resolve(null),
    part(
      'comparison',
      context,
      null,
      () => readUsual(ctx, projectId, row, limits, now),
      unavailable
    ),
  ]);
  const account = await part(
    'account',
    context,
    null,
    () => readAccount(ctx, row, facts),
    unavailable
  );

  const asks = parseJsonList(row.asks, AskSchema, { taskId, column: 'asks' });
  const waiting = [
    ...(facts?.waitingIntervals ?? []),
    ...asks.map((ask) => ({
      startMs: ask.start,
      endMs: ask.end ?? null,
      reason: ask.title ?? null,
    })),
  ];
  const phases = computePhases({
    createdAt,
    machineReadyAt,
    agentStartAt,
    completedAt,
    live,
    lastActivityAt: facts?.lastMessageAt ?? null,
    lastAgentMessageAt: facts?.lastAgentMessageAt ?? null,
    finalCheckAt: pullRequest?.finalCheckAt ?? null,
    hasChecks: pullRequest?.hasChecks ?? false,
    waiting,
    now,
  });
  const resources = readResources(row, reservationOf(row));
  const checks = pullRequest?.outcome.checks ?? null;

  return {
    projectId,
    taskId,
    sessionId,
    title: row.title ?? '',
    status: row.status,
    live,
    createdAt: new Date(createdAt).toISOString(),
    endedAt: new Date(phases.endMs).toISOString(),
    totalMs: phases.totalMs,
    // The question cap is disclosed on the phase it bounds (rule 65): past it, waiting is a floor.
    phases: phases.phases.map((phase) =>
      phase.key === 'waiting' && facts?.waitingLimited ? { ...phase, limited: true } : phase
    ),
    outcome: {
      pullRequest: pullRequest?.outcome.pullRequest ?? null,
      checks,
      ciFirstTry: 'not_recorded',
      terminalReason: row.terminal_reason ?? null,
    },
    account,
    resources,
    toolCalls:
      facts && facts.sessionFound && !facts.messagesArchived
        ? {
            total: facts.toolCalls.total,
            byKind: facts.toolCalls.byKind,
            scanLimited: facts.toolCalls.scanLimited,
          }
        : null,
    tokens: { state: 'not_reported' },
    slowedDown: slowedDown(
      {
        phases,
        usual,
        waiting: facts?.waitingIntervals ?? [],
        askTitles: asks.map((ask) => ({
          startMs: ask.start,
          endMs: ask.end ?? null,
          title: ask.title ?? null,
        })),
        checks,
        peakMemoryBytes: resources.peakMemoryBytes,
        requestedMemoryMb: resources.requestedMemoryMb,
        oomKills: resources.oomKills,
      },
      limits
    ),
    unavailable,
    generatedAt: new Date(now).toISOString(),
  };
}
