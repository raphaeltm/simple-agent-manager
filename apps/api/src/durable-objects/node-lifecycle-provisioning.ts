import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { notifyFailedSweeps } from '../scheduled/failed-sweep-notifications';
import type { DirectProvisioningInput } from '../services/direct-provisioning';
import {
  assertDirectCreationAuthority,
  continueDirectWorkspaceCreation,
} from '../services/direct-workspace-creation';
import { NodeAllocationUncertainError } from '../services/node-allocation-recovery';
import { provisionNode } from '../services/node-provisioning';
import { persistError } from '../services/observability';

export const DIRECT_PROVISIONING_KEY = 'direct-provisioning:v1';
export const DEFAULT_NODE_PROVISIONING_REQUEST_TIMEOUT_MS = 5_000;
export const DEFAULT_NODE_PROVISIONING_RETRY_INTERVAL_MS = 30_000;
export const DEFAULT_NODE_PROVISIONING_MAX_AGE_MS = 15 * 60_000;
export const DEFAULT_NODE_PROVISIONING_MAX_ATTEMPTS = 30;

export interface DirectProvisioningIntent {
  input: DirectProvisioningInput;
  initialIncarnationId: string;
  incarnationId: string;
  createdAt: number;
  allocationComplete?: boolean;
  nextAttemptAt: number | null;
  attempts: number;
  status: 'pending' | 'reporting' | 'complete' | 'failed' | 'unresolved';
  reportAttempts?: number;
  reportError?: string;
  lastError: string | null;
}

function positive(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/** Separate prefixed instances isolate each workspace from the node's warm/deletion alarm. */
export class NodeLifecycleProvisioning {
  private lock: Promise<unknown> = Promise.resolve();
  private inFlight = false;
  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env
  ) {}

  private withLock<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.lock.then(fn);
    this.lock = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  async start(input: DirectProvisioningInput): Promise<void> {
    await this.withLock(async () => {
      const previous =
        await this.ctx.storage.get<DirectProvisioningIntent>(DIRECT_PROVISIONING_KEY);
      if (previous) {
        if (JSON.stringify(previous.input) !== JSON.stringify(input))
          throw new Error('Provisioning intent identity changed');
        if (previous.nextAttemptAt !== null)
          await this.ctx.storage.setAlarm(previous.nextAttemptAt);
        return;
      }
      const node = await this.env.DATABASE.prepare(
        'SELECT user_id,runtime_incarnation_id FROM nodes WHERE id=?'
      )
        .bind(input.nodeId)
        .first<{ user_id: string; runtime_incarnation_id: string | null }>();
      if (!node || node.user_id !== input.userId || !node.runtime_incarnation_id)
        throw new Error('Provisioning node identity is unavailable');
      const intent: DirectProvisioningIntent = {
        input,
        initialIncarnationId: node.runtime_incarnation_id,
        incarnationId: crypto.randomUUID(),
        createdAt: Date.now(),
        nextAttemptAt: Date.now(),
        attempts: 0,
        status: 'pending',
        lastError: null,
      };
      await this.ctx.storage.put(DIRECT_PROVISIONING_KEY, intent);
      await this.ctx.storage.setAlarm(intent.nextAttemptAt ?? Date.now());
    });
  }

  /** Cheap alarm critical path: persist next eligibility before launching bounded network work. */
  async alarm(): Promise<boolean> {
    return this.withLock(async () => {
      const intent = await this.ctx.storage.get<DirectProvisioningIntent>(DIRECT_PROVISIONING_KEY);
      if (!intent) return false;
      if (intent.status !== 'pending' && intent.status !== 'reporting') {
        await this.ctx.storage.deleteAlarm();
        return true;
      }
      if (this.inFlight || (intent.nextAttemptAt !== null && intent.nextAttemptAt > Date.now())) {
        await this.ctx.storage.setAlarm(
          Math.max(intent.nextAttemptAt ?? 0, Date.now() + this.retryMs())
        );
        return true;
      }
      if (
        intent.status === 'reporting' ||
        intent.attempts >=
          positive(
            this.env.NODE_PROVISIONING_MAX_ATTEMPTS,
            DEFAULT_NODE_PROVISIONING_MAX_ATTEMPTS
          ) ||
        Date.now() - intent.createdAt >=
          positive(this.env.NODE_PROVISIONING_MAX_AGE_MS, DEFAULT_NODE_PROVISIONING_MAX_AGE_MS)
      ) {
        intent.status = 'reporting';
        intent.lastError ??=
          'Durable provisioning did not converge before its bounded recovery deadline';
        if (
          (intent.reportAttempts ?? 0) >=
          positive(this.env.NODE_PROVISIONING_MAX_ATTEMPTS, DEFAULT_NODE_PROVISIONING_MAX_ATTEMPTS)
        ) {
          intent.status = 'unresolved';
          intent.nextAttemptAt = null;
          await this.ctx.storage.put(DIRECT_PROVISIONING_KEY, intent);
          await this.ctx.storage.deleteAlarm();
          return true;
        }
        intent.reportAttempts = (intent.reportAttempts ?? 0) + 1;
        intent.nextAttemptAt = Date.now() + this.retryMs();
        await this.ctx.storage.put(DIRECT_PROVISIONING_KEY, intent);
        await this.ctx.storage.setAlarm(intent.nextAttemptAt);
        this.inFlight = true;
        this.ctx.waitUntil(
          this.publishExhaustion(intent).finally(() => {
            this.inFlight = false;
          })
        );
        return true;
      }
      intent.attempts++;
      intent.nextAttemptAt = Date.now() + this.retryMs();
      await this.ctx.storage.put(DIRECT_PROVISIONING_KEY, intent);
      await this.ctx.storage.setAlarm(intent.nextAttemptAt);
      this.inFlight = true;
      this.ctx.waitUntil(
        this.run(intent).finally(() => {
          this.inFlight = false;
        })
      );
      return true;
    });
  }

  private retryMs(): number {
    return positive(
      this.env.NODE_PROVISIONING_RETRY_INTERVAL_MS,
      DEFAULT_NODE_PROVISIONING_RETRY_INTERVAL_MS
    );
  }

  private async run(intent: DirectProvisioningIntent): Promise<void> {
    const timeout = positive(
      this.env.NODE_PROVISIONING_REQUEST_TIMEOUT_MS,
      DEFAULT_NODE_PROVISIONING_REQUEST_TIMEOUT_MS
    );
    const controller = new AbortController();
    const timer = setTimeout(
      () =>
        controller.abort(new NodeAllocationUncertainError('Provisioning request deadline elapsed')),
      timeout
    );
    try {
      const { input } = intent;
      const workspaceInput = input.workspace;
      const db = drizzle(this.env.DATABASE, { schema });
      const node = (
        await db.select().from(schema.nodes).where(eq(schema.nodes.id, input.nodeId)).limit(1)
      )[0];
      if (!node || node.userId !== input.userId) {
        await this.finish(intent, 'failed', 'Node no longer exists or belongs to this intent');
        return;
      }
      const mustAllocate = !input.workspace || input.workspace.mustProvisionNode;
      if (
        mustAllocate &&
        node.runtimeIncarnationId !== intent.initialIncarnationId &&
        node.runtimeIncarnationId !== intent.incarnationId
      ) {
        throw new NodeAllocationUncertainError(
          'Node incarnation changed; operator recovery is required'
        );
      }
      if (mustAllocate && !intent.allocationComplete) {
        const result = await provisionNode(
          input.nodeId,
          { ...this.env, CF_API_TIMEOUT_MS: String(timeout) },
          input.workspace
            ? {
                projectId: input.workspace.placement.projectId,
                chatSessionId: input.workspace.chatSessionId ?? '',
                taskId: input.workspace.taskId,
                taskMode: 'conversation',
              }
            : undefined,
          {
            signal: controller.signal,
            durableAllocation: {
              createdAt: intent.createdAt,
              initialIncarnationId: intent.initialIncarnationId,
              incarnationId: intent.incarnationId,
            },
            authorityProjectId: input.workspace?.placement.projectId,
            assertExternalMutationAuthority: workspaceInput
              ? () => assertDirectCreationAuthority(this.env, workspaceInput, false)
              : undefined,
          }
        );
        const provisioned = await this.env.DATABASE.prepare(
          "SELECT id FROM nodes WHERE id=? AND user_id=? AND runtime_incarnation_id=? AND provider_instance_id IS NOT NULL AND status IN ('creating','running','error') AND runtime_termination_confirmed_at IS NULL"
        )
          .bind(input.nodeId, input.userId, intent.incarnationId)
          .first();
        if (result?.allocationConfirmed && provisioned) {
          // A heartbeat is not allocation completion. Persist only after provisionNode's
          // provider publication and current-authority checks returned positively.
          // A successful asynchronous-IP allocation proceeds through normal heartbeat/DNS backfill.
          await this.withLock(async () => {
            const current =
              await this.ctx.storage.get<DirectProvisioningIntent>(DIRECT_PROVISIONING_KEY);
            if (current?.attempts === intent.attempts && current.status === 'pending') {
              current.allocationComplete = true;
              await this.ctx.storage.put(DIRECT_PROVISIONING_KEY, current);
            }
          });
        }
      }
      if (!input.workspace) {
        const currentNode = await this.env.DATABASE.prepare(
          'SELECT status FROM nodes WHERE id=? AND user_id=? AND runtime_incarnation_id=?'
        )
          .bind(input.nodeId, input.userId, intent.incarnationId)
          .first<{ status: string }>();
        if (currentNode?.status === 'creating') return;
        if (currentNode?.status !== 'running') {
          await this.finish(intent, 'failed', 'Node provisioning did not complete');
          return;
        }
      }
      // Provider work has its own deadline. Readiness/dispatch each use the shorter background tier.
      clearTimeout(timer);
      const continuationEnv = {
        ...this.env,
        CF_API_TIMEOUT_MS: String(timeout),
        NODE_AGENT_READY_TIMEOUT_MS: String(timeout),
        NODE_AGENT_READY_POLL_INTERVAL_MS: String(timeout),
        NODE_AGENT_REQUEST_TIMEOUT_MS: String(timeout),
      };
      const completed =
        !input.workspace ||
        (await continueDirectWorkspaceCreation(
          continuationEnv,
          input.workspace,
          mustAllocate ? intent.incarnationId : undefined
        ));
      if (completed) await this.finish(intent, 'complete', null);
    } catch (error) {
      await this.withLock(async () => {
        const current =
          await this.ctx.storage.get<DirectProvisioningIntent>(DIRECT_PROVISIONING_KEY);
        if (!current || current.attempts !== intent.attempts || current.status !== 'pending')
          return;
        current.lastError = error instanceof Error ? error.message : String(error);
        await this.ctx.storage.put(DIRECT_PROVISIONING_KEY, current);
      });
    } finally {
      clearTimeout(timer);
    }
  }

  private async finish(
    intent: DirectProvisioningIntent,
    status: 'complete' | 'failed',
    message: string | null
  ): Promise<void> {
    await this.withLock(async () => {
      const current = await this.ctx.storage.get<DirectProvisioningIntent>(DIRECT_PROVISIONING_KEY);
      if (!current || current.attempts !== intent.attempts || current.status !== 'pending') return;
      await this.ctx.storage.put(DIRECT_PROVISIONING_KEY, {
        ...current,
        status,
        nextAttemptAt: null,
        lastError: message,
      });
      await this.ctx.storage.deleteAlarm();
    });
  }

  private async publishExhaustion(intent: DirectProvisioningIntent): Promise<void> {
    try {
      await this.reportExhausted(intent);
      await this.withLock(async () => {
        const current =
          await this.ctx.storage.get<DirectProvisioningIntent>(DIRECT_PROVISIONING_KEY);
        if (current?.status !== 'reporting' || current.reportAttempts !== intent.reportAttempts)
          return;
        current.status = 'unresolved';
        current.nextAttemptAt = null;
        delete current.reportError;
        await this.ctx.storage.put(DIRECT_PROVISIONING_KEY, current);
        await this.ctx.storage.deleteAlarm();
      });
    } catch (error) {
      log.error('node_provisioning.recovery_report_failed', { error: String(error) });
      await this.withLock(async () => {
        const current =
          await this.ctx.storage.get<DirectProvisioningIntent>(DIRECT_PROVISIONING_KEY);
        if (current?.status !== 'reporting' || current.reportAttempts !== intent.reportAttempts)
          return;
        current.reportError = String(error);
        await this.ctx.storage.put(DIRECT_PROVISIONING_KEY, current);
      });
    }
  }

  private async reportExhausted(intent: DirectProvisioningIntent): Promise<void> {
    const failureMessage = `Durable provisioning exhausted (${intent.incarnationId}): ${intent.lastError}`;
    await this.env.DATABASE.prepare(
      `UPDATE nodes SET error_message=?,updated_at=?
        WHERE id=? AND user_id=? AND runtime_incarnation_id=? AND runtime_termination_confirmed_at IS NULL
          AND provider_instance_id IS NULL AND status NOT IN ('deleted','stopped')`
    )
      .bind(
        'Allocation unresolved; operator recovery required: ' + intent.lastError,
        new Date().toISOString(),
        intent.input.nodeId,
        intent.input.userId,
        intent.incarnationId
      )
      .run();
    const workspace = intent.input.workspace;
    if (workspace) {
      const changed = await this.env.DATABASE.prepare(
        `UPDATE workspaces SET status='error',error_message=?,updated_at=?
          WHERE id=? AND user_id=? AND project_id=? AND chat_session_id IS ?
          AND (node_id=? OR (?=1 AND node_id IS NULL))
          AND (status='creating' OR (status='error' AND error_message=?)) AND runtime_deletion_confirmed_at IS NULL
          AND EXISTS (SELECT 1 FROM nodes n WHERE n.id=? AND n.user_id=?
            AND n.runtime_incarnation_id IN (?,?))`
      )
        .bind(
          failureMessage,
          new Date().toISOString(),
          workspace.placement.id,
          intent.input.userId,
          workspace.placement.projectId,
          workspace.chatSessionId,
          intent.input.nodeId,
          workspace.mustProvisionNode ? 1 : 0,
          failureMessage,
          intent.input.nodeId,
          intent.input.userId,
          intent.initialIncarnationId,
          intent.incarnationId
        )
        .run();
      if ((changed.meta.changes ?? 0) === 1) {
        // Replays may resume after the workspace write. Only this intent's still-current
        // failure may close metering or fail its task; a concurrent callback/owner change wins.
        const failureScope = `SELECT 1 FROM workspaces w JOIN nodes n ON n.id=?
            WHERE w.id=? AND w.user_id=? AND w.project_id=? AND w.chat_session_id IS ?
            AND (w.node_id=? OR (?=1 AND w.node_id IS NULL)) AND w.status='error'
            AND w.error_message=? AND w.runtime_deletion_confirmed_at IS NULL
            AND n.user_id=w.user_id AND n.runtime_incarnation_id IN (?,?)`;
        const scopeBindings = [
          intent.input.nodeId,
          workspace.placement.id,
          intent.input.userId,
          workspace.placement.projectId,
          workspace.chatSessionId,
          intent.input.nodeId,
          workspace.mustProvisionNode ? 1 : 0,
          failureMessage,
          intent.initialIncarnationId,
          intent.incarnationId,
        ];
        await this.env.DATABASE.prepare(
          `UPDATE compute_usage SET ended_at=?
            WHERE workspace_id=? AND ended_at IS NULL AND EXISTS (${failureScope})`
        )
          .bind(new Date().toISOString(), workspace.placement.id, ...scopeBindings)
          .run();
        await this.env.DATABASE.prepare(
          `UPDATE tasks SET status='failed',error_message=?,updated_at=?
            WHERE id=? AND workspace_id=? AND user_id=? AND status IN ('queued','in_progress')
              AND EXISTS (${failureScope})`
        )
          .bind(
            failureMessage,
            new Date().toISOString(),
            workspace.taskId,
            workspace.placement.id,
            intent.input.userId,
            ...scopeBindings
          )
          .run();
      }
    }
    await persistError(
      this.env.OBSERVABILITY_DATABASE,
      {
        source: 'api',
        level: 'error',
        message: 'Durable provisioning requires operator recovery: ' + intent.lastError,
        nodeId: intent.input.nodeId,
        userId: intent.input.userId,
        context: {
          component: 'node-provisioning',
          nodeId: intent.input.nodeId,
          attempts: intent.attempts,
          runtimeIncarnationId: intent.incarnationId,
          resourceState: 'unknown',
        },
      },
      this.env
    );
    await notifyFailedSweeps(this.env, ['node-provisioning-unresolved']);
  }
}
