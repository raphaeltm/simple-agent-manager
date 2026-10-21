import type { Page } from '@playwright/test';

import type { Json, Turn } from './staging-sam-dispatch-evidence';
import { verifyAwakeBeforeStop } from './staging-sam-dispatch-observation';
import { STOP_CONFIRMATION_MS } from './staging-sam-dispatch-provisioning';

/** Verify stop and repeated confirmation before fallback cleanup can mask a failure. */
export async function confirmAwakeDispatchStop(input: {
  page: Page;
  actionId: string;
  stopMessage: string;
  ledger: Json;
  deadline: number;
  startedAt: number;
  requestMs: number;
  samApi: string;
  projectApi: string;
  stagingApi: string;
  check: (condition: boolean, label: string) => void;
  get: (url: string) => Promise<Json>;
  post: (url: string, body: Json) => Promise<Json>;
  record: (turns: Turn[]) => Promise<Turn[]>;
  save: () => Promise<void>;
}) {
  const { page, ledger, check, record } = input;
  const phaseDeadline = Math.min(input.deadline, Date.now() + STOP_CONFIRMATION_MS);
  const checkRequestBudget = () =>
    check(
      Date.now() + input.requestMs < phaseDeadline,
      'Controlled stop request fits within the work deadline'
    );
  const get = (url: string) => {
    checkRequestBudget();
    return input.get(url);
  };
  const post = (url: string, body: Json) => {
    checkRequestBudget();
    return input.post(url, body);
  };
  await verifyAwakeBeforeStop({ ...input, get });
  const eventsUrl = `${input.stagingApi}/api/nodes/${ledger.nodeId}/events?limit=100`;
  const beforeEvents = await get(eventsUrl);
  check(
    Array.isArray(beforeEvents.events) &&
      !beforeEvents.unavailableReason &&
      beforeEvents.events.some(
        (event: Json | null) =>
          event != null &&
          event.nodeId === ledger.nodeId &&
          typeof event.id === 'string' &&
          /^[a-f0-9]{16}$/.test(event.id) &&
          typeof event.type === 'string' &&
          event.type.length > 0 &&
          typeof event.createdAt === 'string' &&
          Number.isFinite(Date.parse(event.createdAt)) &&
          Date.parse(event.createdAt) <= Date.now()
      ),
    'Scoped VM event baseline is available'
  );
  const previousEventIds = new Set(beforeEvents.events.map((event: Json | null) => event?.id));
  // Stop awaits two background agent signals (5s each), a cleanup delay (5s),
  // and an interactive workspace stop (30s), plus durable bookkeeping. Keep
  // ordinary requests at 15s; reserve two such slots after the bounded ACK.
  const verificationReserveMs = 2 * input.requestMs;
  const ackBudget = () =>
    Math.min(
      STOP_CONFIRMATION_MS - verificationReserveMs,
      phaseDeadline - Date.now() - verificationReserveMs
    );
  check(
    ackBudget() > input.requestMs,
    'Controlled stop confirmation fits within the work deadline'
  );
  const attemptedAt = Date.now();
  const attempt = {
    actionId: input.actionId,
    attemptedAt,
    elapsedMs: 0,
    timeoutMs: 0,
    phaseDeadline,
    status: null as number | null,
    category: 'pending',
    readback: { category: 'not-needed', state: null as string | null },
  };
  ledger.stopConfirmationAttempt = attempt;
  await input.save(); // Record the exact intent before the single UI click.
  // Saving evidence is asynchronous: never use a stale pre-save deadline.
  const timeoutMs = ackBudget();
  check(timeoutMs > input.requestMs, 'Controlled stop confirmation fits within the work deadline');
  attempt.timeoutMs = timeoutMs;
  const confirmed = page
    .waitForResponse(
      (response) =>
        response.url() === `${input.samApi}/actions/${input.actionId}/confirm` &&
        response.request().method() === 'POST',
      { timeout: timeoutMs }
    )
    .then((response) => ({ response, category: 'http-response' }))
    .catch((error: unknown) => ({
      response: null,
      category: error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'wait-error',
    }));
  await page
    .locator('article')
    .filter({ hasText: input.stopMessage })
    .getByRole('button', { name: 'Confirm stop', exact: true })
    .click({ timeout: Math.min(input.requestMs, timeoutMs) });
  const outcome = await confirmed;
  attempt.elapsedMs = Math.max(0, Date.now() - attemptedAt);
  attempt.status = outcome.response?.status() ?? null;
  attempt.category = outcome.category;
  const accepted = outcome.response?.ok() === true;
  if (!accepted) {
    // Observe once without re-confirming. A completed receipt cannot erase the
    // original missing/rejected acknowledgement, and no raw payload enters evidence.
    attempt.readback.category = 'deadline-exhausted';
    if (Date.now() + input.requestMs < phaseDeadline) {
      try {
        const history = await get(`${input.samApi}/turns`);
        const action = (history.turns as Turn[])
          .flatMap((turn) => turn.actions)
          .find((item) => item.id === input.actionId && item.operation === 'sam_work_stop');
        if (!action) attempt.readback.category = 'not-found';
        else if (
          ['pending', 'approval_required', 'completed', 'rejected', 'uncertain'].includes(
            action.state
          )
        ) {
          attempt.readback = { category: 'observed', state: action.state };
        } else attempt.readback.category = 'invalid-state';
      } catch {
        attempt.readback.category = 'read-failed';
      }
    }
    // Preserve the confirmation failure even if saving diagnostic evidence fails.
    await input.save().catch(() => {
      ledger.stopConfirmationDiagnosticSaveFailed = true;
    });
  } else await input.save();
  check(accepted, 'Scoped stop confirmation accepted');
  const stopped = await record((await get(`${input.samApi}/turns`)).turns);
  const stopReceipt = stopped
    .flatMap((turn) => turn.actions)
    .find((action) => action.id === input.actionId);
  check(stopReceipt?.state === 'completed', 'Scoped stop completed');
  const afterEvents = await get(eventsUrl);
  // VM appendNodeEvent timestamps have whole-second precision. Require a new
  // exact scoped event as well as a current timestamp, never a D1 stopped flag
  // or the diagnostic API's empty response when the agent is unavailable.
  const acknowledged =
    Array.isArray(afterEvents.events) && !afterEvents.unavailableReason
      ? afterEvents.events.find((event: Json | null) => {
          const timestamp =
            typeof event?.createdAt === 'string' ? Date.parse(event.createdAt) : NaN;
          return (
            event?.type === 'workspace.stopped' &&
            event.nodeId === ledger.nodeId &&
            event.workspaceId === ledger.workspaceId &&
            typeof event.id === 'string' &&
            /^[a-f0-9]{16}$/.test(event.id) &&
            !previousEventIds.has(event.id) &&
            Number.isFinite(timestamp) &&
            timestamp >= Math.floor(attemptedAt / 1000) * 1000 &&
            timestamp <= Date.now()
          );
        })
      : undefined;
  ledger.stopRuntimeObservation = {
    acknowledged: Boolean(acknowledged),
    eventId: acknowledged?.id ?? null,
    createdAt: acknowledged ? new Date(acknowledged.createdAt).toISOString() : null,
  };
  await input.save();
  check(
    Boolean(acknowledged),
    'Fresh scoped VM stop acknowledgement observed before fallback cleanup'
  );
  const repeated = await post(`${input.samApi}/actions/${input.actionId}/confirm`, {
    approved: true,
  });
  check(
    repeated.action?.id === input.actionId &&
      repeated.action.state === 'completed' &&
      repeated.action.result_json === stopReceipt!.result_json,
    'Repeated confirmation retains same completed receipt'
  );
  const receiptIds = ledger.receipts.map((action: Json) => action.id);
  await record((await get(`${input.samApi}/turns`)).turns);
  check(
    JSON.stringify(ledger.receipts.map((action: Json) => action.id)) === JSON.stringify(receiptIds),
    'Repeated confirmation creates no extra action'
  );
  const task = await get(`${input.projectApi}/tasks/${ledger.taskId}`);
  const session = await get(`${input.projectApi}/sessions/${ledger.sessionId}?limit=1`);
  const workspaces = await get(`${input.stagingApi}/api/workspaces`);
  const workspace = (workspaces as unknown as Json[]).find(
    (candidate) => candidate.id === ledger.workspaceId
  );
  const safeStatus = (value: unknown, allowed: string[]) =>
    typeof value === 'string' && allowed.includes(value) ? value : 'unknown';
  ledger.stopTeardownObservation = {
    taskStatus: safeStatus(task.status, [
      'queued',
      'assigned',
      'running',
      'completed',
      'failed',
      'cancelled',
    ]),
    sessionStatus: safeStatus(session.session.status, [
      'active',
      'idle',
      'sleeping',
      'stopped',
      'failed',
    ]),
    workspacePresent: Boolean(workspace),
    workspaceStatus: workspace
      ? safeStatus(workspace.status, [
          'pending',
          'creating',
          'running',
          'recovery',
          'sleeping',
          'stopping',
          'stopped',
          'deleted',
          'error',
        ])
      : 'absent',
  };
  await input.save();
  // Archive preserves already-terminal tasks and retains the stopped D1 row
  // until deletion TTL. These control-plane reads complement the separate VM
  // acknowledgement above; neither claims container or provider deletion.
  check(
    ['cancelled', 'completed', 'failed'].includes(task.status) &&
      session.session.status === 'stopped' &&
      (!workspace || workspace.status === 'stopped'),
    'Confirmed stop leaves terminal task and stopped control-plane session and workspace before fallback cleanup'
  );
  check(Date.now() < phaseDeadline, 'Stop verification finishes within the work deadline');
  ledger.stopConfirmation = {
    actionId: input.actionId,
    repeatedSameReceipt: true,
    controlPlaneStopVerified: true,
    runtimeStopAcknowledged: true,
  };
}
