import { NodeLifecycle } from '../../../src/durable-objects/node-lifecycle';
import { ProjectData } from '../../../src/durable-objects/project-data';
import * as mailbox from '../../../src/durable-objects/project-data/mailbox';
import * as messages from '../../../src/durable-objects/project-data/messages';

export interface CapturedExpectedError {
  threw: boolean;
  name?: string;
  message?: string;
  code?: string;
  maxMessages?: number;
}

function capture(error: unknown): CapturedExpectedError {
  const typed = error as Error & { code?: string; maxMessages?: number };
  return {
    threw: true,
    name: typed.name,
    message: typed.message,
    code: typed.code,
    maxMessages: typed.maxMessages,
  };
}

/**
 * The workers pool reports expected exceptions escaping a DO method as
 * unhandled errors, even when the caller catches the rejected RPC. Catching
 * inside an inherited test-only class keeps the real operation and storage
 * behavior while returning a serializable assertion value to Vitest.
 */
export class ProjectDataTestDouble extends ProjectData {
  async alarmWithDurablePromptDelivery(): Promise<void> {
    const previous = this.env.DURABLE_PROMPT_DELIVERY_ENABLED;
    this.env.DURABLE_PROMPT_DELIVERY_ENABLED = 'true';
    try {
      await this.alarm();
    } finally {
      if (previous === undefined) delete this.env.DURABLE_PROMPT_DELIVERY_ENABLED;
      else this.env.DURABLE_PROMPT_DELIVERY_ENABLED = previous;
    }
  }

  async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname !== '/__capture-expected-error') {
      return super.fetch(request);
    }

    const input = (await request.json()) as
      | {
          operation: 'persistMessageBatch';
          args: Parameters<ProjectData['persistMessageBatch']>;
        }
      | {
          operation: 'persistMessage';
          args: Parameters<ProjectData['persistMessage']>;
        }
      | {
          operation: 'enqueueMailboxMessage';
          args: Parameters<ProjectData['enqueueMailboxMessage']>;
        };

    try {
      if (input.operation === 'persistMessageBatch') {
        messages.persistMessageBatch(this.ctx.storage.sql, this.env, ...input.args);
      } else if (input.operation === 'persistMessage') {
        messages.persistMessage(this.ctx.storage.sql, this.env, ...input.args);
      } else {
        mailbox.enqueueMessage(this.ctx.storage.sql, ...input.args);
      }
      return Response.json({ threw: false } satisfies CapturedExpectedError);
    } catch (error) {
      return Response.json(capture(error));
    }
  }
}

export class NodeLifecycleTestDouble extends NodeLifecycle {
  async fetch(request: Request): Promise<Response> {
    const input = (await request.json()) as
      | {
          operation: 'markIdle';
          args: Parameters<NodeLifecycle['markIdle']>;
        }
      | { operation: 'markActive' };

    try {
      if (input.operation === 'markIdle') await this.markIdle(...input.args);
      else await this.markActive();
      return Response.json({ threw: false } satisfies CapturedExpectedError);
    } catch (error) {
      return Response.json(capture(error));
    }
  }
}

export async function captureProjectDataExpectedError(
  stub: DurableObjectStub<ProjectDataTestDouble>,
  input:
    | {
        operation: 'persistMessageBatch';
        args: Parameters<ProjectData['persistMessageBatch']>;
      }
    | {
        operation: 'persistMessage';
        args: Parameters<ProjectData['persistMessage']>;
      }
    | {
        operation: 'enqueueMailboxMessage';
        args: Parameters<ProjectData['enqueueMailboxMessage']>;
      }
): Promise<CapturedExpectedError> {
  const response = await stub.fetch('https://project-data.test/__capture-expected-error', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  return response.json<CapturedExpectedError>();
}

export async function captureNodeLifecycleExpectedError(
  stub: DurableObjectStub<NodeLifecycleTestDouble>,
  input:
    | {
        operation: 'markIdle';
        args: Parameters<NodeLifecycle['markIdle']>;
      }
    | { operation: 'markActive' }
): Promise<CapturedExpectedError> {
  const response = await stub.fetch('https://node-lifecycle.test/__capture-expected-error', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  return response.json<CapturedExpectedError>();
}
