import type { PromptDeliveryResult } from '../durable-objects/project-data/prompt-delivery';

/** Only preparation belongs here: the callback must never submit a prompt. */
export async function prepareVmPromptDelivery<T>(
  timeoutMs: number,
  prepare: () => Promise<T>
): Promise<T | PromptDeliveryResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      prepare(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Target preparation deadline elapsed')), timeoutMs);
      }),
    ]);
  } catch (error) {
    // Target lookup/recovery may finish later, but it cannot continue into a
    // prompt send. Keep the durable claim retryable while that work converges.
    return {
      kind: 'retry',
      reason: 'not_ready',
      error: `Prompt target preparation failed: ${error instanceof Error ? error.message : String(error)}`,
      runtimeIdentity: null,
      capabilities: null,
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
