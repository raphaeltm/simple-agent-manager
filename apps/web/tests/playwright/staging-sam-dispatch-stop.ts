import type { Page } from '@playwright/test';

import type { Json, Turn } from './staging-sam-dispatch-evidence';
import { verifyAwakeBeforeStop } from './staging-sam-dispatch-observation';

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
}) {
  const { page, ledger, check, get, post, record } = input;
  await verifyAwakeBeforeStop(input);
  check(
    Date.now() + input.requestMs < input.deadline,
    'Controlled stop confirmation fits within the work deadline'
  );
  const confirmed = page
    .waitForResponse(
      (response) =>
        response.url() === `${input.samApi}/actions/${input.actionId}/confirm` &&
        response.request().method() === 'POST',
      { timeout: input.requestMs }
    )
    .catch(() => null);
  await page
    .locator('article')
    .filter({ hasText: input.stopMessage })
    .getByRole('button', { name: 'Confirm this action', exact: true })
    .click();
  check((await confirmed)?.ok() === true, 'Scoped stop confirmation accepted');
  const stopped = await record((await get(`${input.samApi}/turns`)).turns);
  const stopReceipt = stopped
    .flatMap((turn) => turn.actions)
    .find((action) => action.id === input.actionId);
  check(stopReceipt?.state === 'completed', 'Scoped stop completed');
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
  check(
    task.status === 'cancelled' &&
      session.session.status === 'stopped' &&
      !(workspaces as unknown as Json[]).some((workspace) => workspace.id === ledger.workspaceId),
    'Confirmed stop cancels task and removes its awake workspace before fallback cleanup'
  );
  check(Date.now() < input.deadline, 'Stop verification finishes within the work deadline');
  ledger.stopConfirmation = {
    actionId: input.actionId,
    repeatedSameReceipt: true,
    teardownVerified: true,
  };
}
