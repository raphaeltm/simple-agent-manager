/** SAM resource policy around the vendored git engine; never imported by Cloudflare. */
import { AsyncLocalStorage } from 'node:async_hooks';

export interface GitWorkLimits {
  maxObjectBytes: number;
  maxInflatedBytes: number;
  maxDeltaDepth: number;
  workTimeoutMs: number;
}

const budgets = new AsyncLocalStorage<{
  limits: GitWorkLimits;
  remaining: number;
  deadline: number;
}>();

export function withGitWorkBudget<T>(limits: GitWorkLimits, action: () => T): T {
  return budgets.run(
    { limits, remaining: limits.maxInflatedBytes, deadline: Date.now() + limits.workTimeoutMs },
    action
  );
}

export function gitWorkLimits(): GitWorkLimits {
  const budget = budgets.getStore();
  if (!budget) throw new Error('git resource budget is missing');
  if (Date.now() >= budget.deadline) throw new Error('git work exceeds time budget');
  return budget.limits;
}

/** Charge output before storing/allocating it, including repeated reads and delta outputs. */
export function chargeGitWork(bytes: number): void {
  const limits = gitWorkLimits();
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > limits.maxObjectBytes) {
    throw new Error('git object exceeds inflated size limit');
  }
  const budget = budgets.getStore();
  if (!budget) throw new Error('git resource budget is missing');
  if (bytes > budget.remaining) throw new Error('git work exceeds decompression budget');
  budget.remaining -= bytes;
}

/** A stalled client cannot hold a repository's receive lock past its request budget. */
export async function readGitChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>
): Promise<ReadableStreamReadResult<Uint8Array>> {
  gitWorkLimits();
  const budget = budgets.getStore();
  if (!budget) throw new Error('git resource budget is missing');
  const remaining = budget.deadline - Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error('git work exceeds time budget'));
          void reader.cancel().catch(() => undefined);
        }, remaining);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Keep resource accounting attached when the runtime pulls a response after fetch returns. */
export function bindGitResponse(response: Response): Response {
  if (!response.body) return response;
  const budget = budgets.getStore();
  if (!budget) throw new Error('git resource budget is missing');
  const reader = response.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    pull: (controller) =>
      budgets.run(budget, async () => {
        try {
          const { done, value } = await readGitChunk(reader);
          if (done) controller.close();
          else controller.enqueue(value);
        } catch (error) {
          void reader.cancel().catch(() => undefined);
          controller.error(error);
        }
      }),
    cancel: (reason) => reader.cancel(reason),
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
