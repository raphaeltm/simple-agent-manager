import { NodeLifecycle } from '../../../src/durable-objects/node-lifecycle';
import { ProjectData } from '../../../src/durable-objects/project-data';
import * as mailbox from '../../../src/durable-objects/project-data/mailbox';
import * as messagePersistence from '../../../src/durable-objects/project-data/message-persistence';
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

type ProjectDataExpectedErrorOperation =
  | {
      operation: 'ensureProjectId';
      args: Parameters<ProjectData['ensureProjectId']>;
    }
  | {
      operation: 'archivePrepareTarget';
      args: Parameters<ProjectData['archivePrepareTarget']>;
    }
  | {
      operation: 'archiveFinalizeSource';
      args: Parameters<ProjectData['archiveFinalizeSource']>;
    }
  | {
      operation: 'archiveReadSourceChunk';
      args: Parameters<ProjectData['archiveReadSourceChunk']>;
    }
  | {
      operation: 'archiveGetNextTargetManifestPage';
      args: Parameters<ProjectData['archiveGetNextTargetManifestPage']>;
    }
  | {
      operation: 'archiveCommitTargetChunk';
      args: Parameters<ProjectData['archiveCommitTargetChunk']>;
    }
  | {
      operation: 'acceptPromptDelivery';
      args: Parameters<ProjectData['acceptPromptDelivery']>;
    }
  | {
      operation: 'persistMessageBatch';
      args: Parameters<ProjectData['persistMessageBatch']>;
    }
  | {
      operation: 'persistMessage';
      args: Parameters<ProjectData['persistMessage']>;
    }
  | {
      operation: 'getMessages';
      args: Parameters<ProjectData['getMessages']>;
    }
  | {
      operation: 'getMessageCount';
      args: Parameters<ProjectData['getMessageCount']>;
    }
  | {
      operation: 'getMessageToolContent';
      args: Parameters<ProjectData['getMessageToolContent']>;
    }
  | {
      operation: 'getArchivedToolPayloads';
      args: Parameters<ProjectData['getArchivedToolPayloads']>;
    }
  | {
      operation: 'archiveGetMessages';
      args: Parameters<ProjectData['archiveGetMessages']>;
    }
  | {
      operation: 'searchMessages';
      args: Parameters<ProjectData['searchMessages']>;
    }
  | {
      operation: 'getLatestPersistedPlan';
      args: Parameters<ProjectData['getLatestPersistedPlan']>;
    }
  | {
      operation: 'createCommentThread';
      args: Parameters<ProjectData['createCommentThread']>;
    }
  | {
      operation: 'enqueueMailboxMessage';
      args: Parameters<ProjectData['enqueueMailboxMessage']>;
    }
  | {
      operation: 'admitProjectEvent';
      args: Parameters<ProjectData['admitProjectEvent']>;
    }
  | {
      operation: 'createProjectEventSubscription';
      args: Parameters<ProjectData['createProjectEventSubscription']>;
    }
  | {
      operation: 'createProjectEventDeliveryBatch';
      args: Parameters<ProjectData['createProjectEventDeliveryBatch']>;
    }
  | {
      operation: 'recordProjectEventDeliveryAttempt';
      args: Parameters<ProjectData['recordProjectEventDeliveryAttempt']>;
    }
  | {
      operation: 'runProjectEventRetention';
      args: Parameters<ProjectData['runProjectEventRetention']>;
    };

/**
 * The workers pool reports expected exceptions escaping a DO method as
 * unhandled errors, even when the caller catches the rejected RPC. Catching
 * inside an inherited test-only class keeps the real operation and storage
 * behavior while returning a serializable assertion value to Vitest.
 */
export class ProjectDataTestDouble extends ProjectData {
  /**
   * Read `do_meta.projectId` straight out of DO SQLite, so a test can tell
   * "this DO has been ensured" apart from "this isolate believes it has".
   */
  readPersistedProjectId(): string | null {
    const row = this.ctx.storage.sql
      .exec('SELECT value FROM do_meta WHERE key = ?', 'projectId')
      .toArray()[0] as { value?: unknown } | undefined;
    return typeof row?.value === 'string' ? row.value : null;
  }

  /**
   * Drive the D1 summary write-back without waiting on the debounce timer.
   *
   * Goes through the LOCKED path, exactly as the production timer callback does,
   * so an overlapping-sync test actually exercises the mutex rather than a
   * bypass that could never observe the race.
   */
  async runSummarySyncForTest(): Promise<void> {
    await this.runSummarySyncLocked();
  }

  /**
   * Same, with env overrides applied for the duration of the sync — so a test can
   * exercise a row cap it would otherwise need thousands of sessions to hit.
   * Restored afterwards so the override cannot leak into a later assertion.
   */
  async runSummarySyncWithEnvForTest(overrides: Record<string, string>): Promise<void> {
    const mutableEnv = this.env as unknown as Record<string, string | undefined>;
    const previous = new Map<string, string | undefined>();
    for (const [key, value] of Object.entries(overrides)) {
      previous.set(key, mutableEnv[key]);
      mutableEnv[key] = value;
    }
    try {
      await this.runSummarySyncLocked();
    } finally {
      for (const [key, value] of previous) {
        if (value === undefined) delete mutableEnv[key];
        else mutableEnv[key] = value;
      }
    }
  }

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

    const input = (await request.json()) as ProjectDataExpectedErrorOperation;

    try {
      if (input.operation === 'ensureProjectId') {
        this.ensureProjectId(...input.args);
      } else if (input.operation === 'archivePrepareTarget') {
        this.archivePrepareTarget(...input.args);
      } else if (input.operation === 'archiveFinalizeSource') {
        await this.archiveFinalizeSource(...input.args);
      } else if (input.operation === 'archiveReadSourceChunk') {
        await this.archiveReadSourceChunk(...input.args);
      } else if (input.operation === 'archiveGetNextTargetManifestPage') {
        this.archiveGetNextTargetManifestPage(...input.args);
      } else if (input.operation === 'archiveCommitTargetChunk') {
        await this.archiveCommitTargetChunk(...input.args);
      } else if (input.operation === 'acceptPromptDelivery') {
        await this.acceptPromptDelivery(...input.args);
      } else if (input.operation === 'persistMessageBatch') {
        messagePersistence.assertRootMessageWriteAllowed(this.ctx.storage.sql, input.args[0]);
        messages.persistMessageBatch(this.ctx.storage.sql, this.env, ...input.args);
      } else if (input.operation === 'persistMessage') {
        messagePersistence.assertRootMessageWriteAllowed(this.ctx.storage.sql, input.args[0]);
        messages.persistMessage(this.ctx.storage.sql, this.env, ...input.args);
      } else if (input.operation === 'getMessages') {
        await this.getMessages(...input.args);
      } else if (input.operation === 'getMessageCount') {
        this.getMessageCount(...input.args);
      } else if (input.operation === 'getMessageToolContent') {
        await this.getMessageToolContent(...input.args);
      } else if (input.operation === 'getArchivedToolPayloads') {
        await this.getArchivedToolPayloads(...input.args);
      } else if (input.operation === 'archiveGetMessages') {
        this.archiveGetMessages(...input.args);
      } else if (input.operation === 'searchMessages') {
        this.searchMessages(...input.args);
      } else if (input.operation === 'getLatestPersistedPlan') {
        this.getLatestPersistedPlan(...input.args);
      } else if (input.operation === 'createCommentThread') {
        this.createCommentThread(...input.args);
      } else if (input.operation === 'admitProjectEvent') {
        this.admitProjectEvent(...input.args);
      } else if (input.operation === 'createProjectEventSubscription') {
        this.createProjectEventSubscription(...input.args);
      } else if (input.operation === 'createProjectEventDeliveryBatch') {
        this.createProjectEventDeliveryBatch(...input.args);
      } else if (input.operation === 'recordProjectEventDeliveryAttempt') {
        this.recordProjectEventDeliveryAttempt(...input.args);
      } else if (input.operation === 'runProjectEventRetention') {
        this.runProjectEventRetention(...input.args);
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
  input: ProjectDataExpectedErrorOperation
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
