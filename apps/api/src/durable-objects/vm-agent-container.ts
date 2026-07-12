import { Container, switchPort } from '@cloudflare/containers';
import { desc, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { signCallbackToken, signNodeCallbackToken, signNodeManagementToken } from '../services/jwt';

export const DEFAULT_CF_CONTAINER_SLEEP_AFTER = '1h';
export const DEFAULT_CF_CONTAINER_ACTIVE_WORK_MAX_MS = 2 * 60 * 60 * 1000;
export const DEFAULT_CF_CONTAINER_KEEPALIVE_RENEW_INTERVAL_MS = 5 * 60 * 1000;

export interface VmAgentContainerLaunchConfig {
  nodeId: string;
  workspaceId: string;
  projectId: string;
  chatSessionId: string;
  repository: string;
  branch: string;
  workspaceDir: string;
  controlPlaneUrl: string;
  vmAgentPort: number;
}

export interface VmAgentContainerLaunchSecrets {
  nodeCallbackToken: string;
}

type LifecycleStatus = 'launching' | 'running' | 'stopping' | 'stopped' | 'sleeping' | 'expired' | 'error';

type ActiveWorkStatus = 'active' | 'ended' | 'expired';

interface ActiveWorkState {
  status: ActiveWorkStatus;
  nodeId: string;
  workspaceId: string;
  agentSessionId: string;
  reason: string;
  activeSince: number;
  lastRenewedAt: number;
  deadlineAt: number;
  endedAt?: number;
  endReason?: string;
}

const ACTIVE_WORK_KEY = 'activeWork';
const KEEPALIVE_CALLBACK = 'renewActiveWorkKeepalive';
const WAKE_DEGRADED_RESPONSE = 'Workspace woke with degraded snapshot restore; retry the prompt or fork from transcript history.';

export class VmAgentContainer extends Container<Env> {
  defaultPort = 8080;
  requiredPorts = [8080];
  sleepAfter = DEFAULT_CF_CONTAINER_SLEEP_AFTER;
  enableInternet = true;

  // Serializes wake-from-snapshot so two concurrent requests to a sleeping
  // container do not both launch a fresh container + restore. DO request
  // handlers interleave across `await`, so the sleeping-check + wake must run
  // as one critical section (see .claude/rules/45).
  private wakeChain: Promise<unknown> = Promise.resolve();

  constructor(ctx: DurableObjectState<Record<string, never>>, env: Env) {
    super(ctx, env);
    const configuredPort = Number.parseInt(env.CF_CONTAINER_VM_AGENT_PORT || env.SANDBOX_VM_AGENT_PORT || '', 10);
    if (Number.isFinite(configuredPort) && configuredPort > 0) {
      this.defaultPort = configuredPort;
      this.requiredPorts = [configuredPort];
    }
    this.sleepAfter = env.CF_CONTAINER_SLEEP_AFTER || env.SANDBOX_SLEEP_AFTER || DEFAULT_CF_CONTAINER_SLEEP_AFTER;
  }

  async launch(
    config: VmAgentContainerLaunchConfig,
    secrets: VmAgentContainerLaunchSecrets
  ): Promise<void> {
    await this.ctx.storage.put('launchConfig', config);
    await this.ctx.storage.put('lifecycleStatus', 'launching' satisfies LifecycleStatus);
    await this.ctx.storage.delete(ACTIVE_WORK_KEY);
    await this.clearKeepaliveSchedule();

    await this.startAndWaitForPorts({
      ports: config.vmAgentPort,
      startOptions: {
        envVars: {
          NODE_ROLE: 'standalone',
          NODE_ID: config.nodeId,
          WORKSPACE_ID: config.workspaceId,
          PROJECT_ID: config.projectId,
          CHAT_SESSION_ID: config.chatSessionId,
          CONTROL_PLANE_URL: config.controlPlaneUrl,
          CALLBACK_TOKEN: secrets.nodeCallbackToken,
          REPOSITORY: config.repository,
          BRANCH: config.branch,
          WORKSPACE_DIR: config.workspaceDir,
          CONTAINER_WORK_DIR: config.workspaceDir,
          CONTAINER_MODE: 'false',
          PORT_SCAN_ENABLED: 'false',
          VM_AGENT_PORT: String(config.vmAgentPort),
          VM_AGENT_PROTOCOL: 'http',
          COOKIE_SECURE: 'true',
        },
        labels: {
          nodeId: config.nodeId,
          workspaceId: config.workspaceId,
          runtime: 'cf-container',
        },
      },
      cancellationOptions: {
        portReadyTimeoutMS: this.getPortReadyTimeoutMs(),
      },
    });

    await this.ctx.storage.put('lifecycleStatus', 'running' satisfies LifecycleStatus);
  }

  async proxyHttp(request: Request, port?: number): Promise<Response> {
    let state = await this.getState();
    const lifecycleStatus = await this.ctx.storage.get<LifecycleStatus>('lifecycleStatus');
    if (lifecycleStatus === 'sleeping') {
      const wake = await this.ensureAwake();
      if (!wake.ok) {
        return new Response(wake.message || WAKE_DEGRADED_RESPONSE, { status: 503 });
      }
      // wakeFromSnapshot launched a fresh container and restored the session.
      // Re-read the container state so the stopped-check below reflects the
      // now-running container instead of the pre-wake stopped snapshot,
      // otherwise a successfully-woken session is wrongly rejected with 410.
      state = await this.getState();
    }
    if (state.status === 'stopped' || state.status === 'stopped_with_code') {
      return new Response('Container is stopped; create a new instant session.', { status: 410 });
    }
    return this.containerFetch(request, port ?? this.defaultPort);
  }

  async stopForUser(): Promise<void> {
    await this.markActiveWorkEnded('user_stop');
    await this.ctx.storage.put('lifecycleStatus', 'stopping' satisfies LifecycleStatus);
    await this.stop();
  }

  async destroyForUser(): Promise<void> {
    await this.markActiveWorkEnded('user_destroy');
    await this.ctx.storage.put('lifecycleStatus', 'stopping' satisfies LifecycleStatus);
    await this.destroy();
  }

  async markActiveWorkStarted(input: {
    workspaceId: string;
    agentSessionId: string;
    reason: string;
  }): Promise<void> {
    const config = await this.ctx.storage.get<VmAgentContainerLaunchConfig>('launchConfig');
    const now = Date.now();
    const nodeId = config?.nodeId ?? input.workspaceId;
    const activeWork: ActiveWorkState = {
      status: 'active',
      nodeId,
      workspaceId: input.workspaceId,
      agentSessionId: input.agentSessionId,
      reason: input.reason,
      activeSince: now,
      lastRenewedAt: now,
      deadlineAt: now + this.getActiveWorkMaxMs(),
    };
    this.renewActivityTimeout();
    await this.ctx.storage.put(ACTIVE_WORK_KEY, activeWork);
    await this.replaceKeepaliveSchedule(this.getKeepaliveRenewIntervalMs());
    log.info('vm_agent_container_active_work_started', {
      nodeId,
      workspaceId: input.workspaceId,
      agentSessionId: input.agentSessionId,
      reason: input.reason,
      activeSince: new Date(now).toISOString(),
      deadlineAt: new Date(activeWork.deadlineAt).toISOString(),
    });
  }

  async markActiveWorkEnded(reason: string): Promise<void> {
    const activeWork = await this.ctx.storage.get<ActiveWorkState>(ACTIVE_WORK_KEY);
    if (!activeWork || activeWork.status !== 'active') {
      await this.clearKeepaliveSchedule();
      return;
    }
    const now = Date.now();
    await this.ctx.storage.put(ACTIVE_WORK_KEY, {
      ...activeWork,
      status: 'ended',
      endedAt: now,
      endReason: reason,
    } satisfies ActiveWorkState);
    await this.clearKeepaliveSchedule();
    log.info('vm_agent_container_active_work_ended', {
      nodeId: activeWork.nodeId,
      workspaceId: activeWork.workspaceId,
      agentSessionId: activeWork.agentSessionId,
      reason,
      activeSince: new Date(activeWork.activeSince).toISOString(),
      lastRenewedAt: new Date(activeWork.lastRenewedAt).toISOString(),
      endedAt: new Date(now).toISOString(),
    });
  }

  async renewActiveWorkKeepalive(): Promise<void> {
    const activeWork = await this.ctx.storage.get<ActiveWorkState>(ACTIVE_WORK_KEY);
    if (!activeWork || activeWork.status !== 'active') {
      await this.clearKeepaliveSchedule();
      return;
    }
    const now = Date.now();
    if (now >= activeWork.deadlineAt) {
      await this.ctx.storage.put(ACTIVE_WORK_KEY, {
        ...activeWork,
        status: 'expired',
        endedAt: now,
        endReason: 'keepalive_deadline_exceeded',
      } satisfies ActiveWorkState);
      await this.clearKeepaliveSchedule();
      log.warn('vm_agent_container_active_work_keepalive_expired', {
        nodeId: activeWork.nodeId,
        workspaceId: activeWork.workspaceId,
        agentSessionId: activeWork.agentSessionId,
        activeSince: new Date(activeWork.activeSince).toISOString(),
        lastRenewedAt: new Date(activeWork.lastRenewedAt).toISOString(),
        deadlineAt: new Date(activeWork.deadlineAt).toISOString(),
      });
      return;
    }

    this.renewActivityTimeout();
    await this.ctx.storage.put(ACTIVE_WORK_KEY, {
      ...activeWork,
      lastRenewedAt: now,
    } satisfies ActiveWorkState);
    await this.replaceKeepaliveSchedule(this.getKeepaliveRenewIntervalMs());
    log.debug('vm_agent_container_active_work_keepalive_renewed', {
      nodeId: activeWork.nodeId,
      workspaceId: activeWork.workspaceId,
      agentSessionId: activeWork.agentSessionId,
      activeSince: new Date(activeWork.activeSince).toISOString(),
      lastRenewedAt: new Date(now).toISOString(),
      deadlineAt: new Date(activeWork.deadlineAt).toISOString(),
    });
  }

  override async fetch(request: Request): Promise<Response> {
    let state = await this.getState();
    const lifecycleStatus = await this.ctx.storage.get<LifecycleStatus>('lifecycleStatus');
    if (lifecycleStatus === 'sleeping') {
      const wake = await this.ensureAwake();
      if (!wake.ok) {
        return new Response(wake.message || WAKE_DEGRADED_RESPONSE, { status: 503 });
      }
      // Re-read the container state after wake so the stopped-check reflects
      // the freshly-launched container, not the pre-wake stopped snapshot.
      state = await this.getState();
    }
    if (state.status === 'stopped' || state.status === 'stopped_with_code') {
      return new Response('Container is stopped; create a new instant session.', { status: 410 });
    }
    return super.fetch(switchPort(request, this.defaultPort));
  }

  override async onStart(): Promise<void> {
    await this.ctx.storage.put('lifecycleStatus', 'running' satisfies LifecycleStatus);
  }

  override async onStop(params: { exitCode: number; reason: 'exit' | 'runtime_signal' }): Promise<void> {
    const status = await this.ctx.storage.get<LifecycleStatus>('lifecycleStatus');
    if (status === 'expired' || status === 'sleeping') {
      return;
    }
    const explicitStop = status === 'stopping';
    await this.markRuntimeEnded(
      explicitStop ? 'stopped' : 'error',
      explicitStop ? 'Container stopped by user request' : `Container stopped: ${params.reason} (${params.exitCode})`
    );
    await this.ctx.storage.put('lifecycleStatus', explicitStop ? 'stopped' : 'error');
  }

  override async onActivityExpired(): Promise<void> {
    const activeWork = await this.ctx.storage.get<ActiveWorkState>(ACTIVE_WORK_KEY);
    if (activeWork?.status === 'active' && Date.now() < activeWork.deadlineAt) {
      await this.renewActiveWorkKeepalive();
      return;
    }
    await this.markRuntimeSleeping('Container idle timeout expired; container is sleeping.');
    await this.ctx.storage.put('lifecycleStatus', 'sleeping' satisfies LifecycleStatus);
    await this.stop();
  }

  override async onError(error: unknown): Promise<void> {
    await this.markRuntimeEnded(
      'error',
      error instanceof Error ? `Container error: ${error.message}` : `Container error: ${String(error)}`
    );
    await this.ctx.storage.put('lifecycleStatus', 'error' satisfies LifecycleStatus);
  }

  private getPortReadyTimeoutMs(): number {
    const raw = this.env.CF_CONTAINER_PORT_READY_TIMEOUT_MS || this.env.SANDBOX_EXEC_TIMEOUT_MS;
    const parsed = raw ? Number.parseInt(raw, 10) : 30_000;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 30_000;
  }

  private getActiveWorkMaxMs(): number {
    const raw = this.env.CF_CONTAINER_ACTIVE_WORK_MAX_MS;
    const parsed = raw ? Number.parseInt(raw, 10) : DEFAULT_CF_CONTAINER_ACTIVE_WORK_MAX_MS;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_CF_CONTAINER_ACTIVE_WORK_MAX_MS;
  }

  private getKeepaliveRenewIntervalMs(): number {
    const raw = this.env.CF_CONTAINER_KEEPALIVE_RENEW_INTERVAL_MS;
    const parsed = raw ? Number.parseInt(raw, 10) : DEFAULT_CF_CONTAINER_KEEPALIVE_RENEW_INTERVAL_MS;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_CF_CONTAINER_KEEPALIVE_RENEW_INTERVAL_MS;
  }

  /**
   * Wake a sleeping container exactly once under concurrency. Serializes on
   * `wakeChain` and re-reads `lifecycleStatus` inside the critical section, so a
   * second request that arrives while the first is waking sees `running` and
   * skips a duplicate launch/restore instead of racing it (see rule 45).
   */
  private async ensureAwake(): Promise<{ ok: boolean; message?: string }> {
    const run = this.wakeChain.then(async () => {
      const status = await this.ctx.storage.get<LifecycleStatus>('lifecycleStatus');
      if (status !== 'sleeping') {
        return { ok: true };
      }
      return this.wakeFromSnapshot();
    });
    // Keep the chain alive even if this wake rejects, so a failure does not
    // permanently wedge all future wakes.
    this.wakeChain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private async wakeFromSnapshot(): Promise<{ ok: boolean; message?: string }> {
    const config = await this.ctx.storage.get<VmAgentContainerLaunchConfig>('launchConfig');
    if (!config) {
      return { ok: false, message: 'Container launch configuration is unavailable.' };
    }
    const db = drizzle(this.env.DATABASE, { schema });
    const workspace = await db
      .select({
        userId: schema.workspaces.userId,
        chatSessionId: schema.workspaces.chatSessionId,
      })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, config.workspaceId))
      .get();
    if (!workspace?.chatSessionId) {
      return { ok: false, message: 'Workspace session metadata is unavailable.' };
    }
    const agentSession = await db
      .select({ id: schema.agentSessions.id, agentType: schema.agentSessions.agentType })
      .from(schema.agentSessions)
      .where(eq(schema.agentSessions.workspaceId, config.workspaceId))
      .orderBy(desc(schema.agentSessions.updatedAt))
      .get();
    if (!agentSession) {
      return { ok: false, message: 'Agent session metadata is unavailable.' };
    }

    log.info('vm_agent_container_wake_started', {
      nodeId: config.nodeId,
      workspaceId: config.workspaceId,
      chatSessionId: workspace.chatSessionId,
      agentSessionId: agentSession.id,
    });

    await this.ctx.storage.put('lifecycleStatus', 'launching' satisfies LifecycleStatus);
    // The container's CALLBACK_TOKEN must be node-scoped to match the initial
    // launch (see launchInstantSession): the vm-agent uses it for node callbacks
    // (error/activity/message reporting) which reject workspace-scoped tokens.
    // Using a workspace-scoped token here caused restored sessions to accept a
    // prompt (200) but silently fail to report the agent's reply back (403
    // "Insufficient token scope"), so no answer appeared after wake.
    const callbackToken = await signNodeCallbackToken(config.nodeId, this.env);
    await this.launch(config, { nodeCallbackToken: callbackToken });

    // The fresh container never ran create-workspace, so its workspace-scoped
    // runtime.CallbackToken is unset. The message reporter and snapshot
    // callbacks require it (they do NOT fall back to the node-scoped token), so
    // pass it on the restore request; without it, restored sessions accept a
    // prompt but silently discard the agent's reply ("no auth token").
    const workspaceCallbackToken = await signCallbackToken(config.workspaceId, this.env);
    const { token } = await signNodeManagementToken(workspace.userId, config.nodeId, config.workspaceId, this.env);
    const restoreUrl = new URL(`http://localhost:${config.vmAgentPort}/workspaces/${config.workspaceId}/agent-sessions/${agentSession.id}/restore`);
    const restoreResponse = await this.containerFetch(
      new Request(restoreUrl.toString(), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'X-SAM-Node-Id': config.nodeId,
          'X-SAM-Workspace-Id': config.workspaceId,
        },
        body: JSON.stringify({
          chatSessionId: workspace.chatSessionId,
          runtime: 'cf-container',
          agentType: agentSession.agentType,
          workspaceCallbackToken,
        }),
      }),
      config.vmAgentPort
    );
    const restoreBody = await restoreResponse.text().catch(() => '');
    if (!restoreResponse.ok) {
      await this.markWakeDegraded(config, restoreBody || `restore failed with HTTP ${restoreResponse.status}`);
      return { ok: false, message: restoreBody || 'Session restore failed.' };
    }
    let restoreStatus = '';
    try {
      const parsed = JSON.parse(restoreBody) as { status?: unknown };
      restoreStatus = typeof parsed.status === 'string' ? parsed.status : '';
    } catch {
      // A successful restore must provide an explicit machine-readable status.
    }
    if (restoreStatus !== 'restored') {
      const message = restoreBody || 'Session restore did not report restored status.';
      await this.markWakeDegraded(config, message);
      return { ok: false, message };
    }

    const now = new Date().toISOString();
    await db.update(schema.nodes).set({
      status: 'running',
      healthStatus: 'healthy',
      errorMessage: null,
      updatedAt: now,
    }).where(eq(schema.nodes.id, config.nodeId));
    await db.update(schema.workspaces).set({
      status: 'running',
      errorMessage: null,
      updatedAt: now,
    }).where(eq(schema.workspaces.id, config.workspaceId));
    await db.update(schema.agentSessions).set({
      status: 'running',
      errorMessage: null,
      updatedAt: now,
    }).where(eq(schema.agentSessions.id, agentSession.id));
    await this.ctx.storage.put('lifecycleStatus', 'running' satisfies LifecycleStatus);

    log.info('vm_agent_container_wake_completed', {
      nodeId: config.nodeId,
      workspaceId: config.workspaceId,
      chatSessionId: workspace.chatSessionId,
      agentSessionId: agentSession.id,
    });
    return { ok: true };
  }

  private async markWakeDegraded(config: VmAgentContainerLaunchConfig, message: string): Promise<void> {
    const now = new Date().toISOString();
    const db = drizzle(this.env.DATABASE, { schema });
    await db.update(schema.workspaces).set({
      status: 'recovery',
      errorMessage: message,
      updatedAt: now,
    }).where(eq(schema.workspaces.id, config.workspaceId));
    await db.update(schema.agentSessions).set({
      status: 'error',
      errorMessage: message,
      updatedAt: now,
    }).where(eq(schema.agentSessions.workspaceId, config.workspaceId));
    log.warn('vm_agent_container_wake_degraded', {
      nodeId: config.nodeId,
      workspaceId: config.workspaceId,
      message,
    });
  }

  private async replaceKeepaliveSchedule(delayMs: number): Promise<void> {
    await this.clearKeepaliveSchedule();
    await this.schedule(Math.max(1, Math.ceil(delayMs / 1000)), KEEPALIVE_CALLBACK);
  }

  private async clearKeepaliveSchedule(): Promise<void> {
    await this.deleteSchedules(KEEPALIVE_CALLBACK);
  }

  private async markRuntimeSleeping(message: string): Promise<void> {
    const config = await this.ctx.storage.get<VmAgentContainerLaunchConfig>('launchConfig');
    if (!config) {
      return;
    }

    await this.markActiveWorkEnded('container_idle_sleeping');

    const now = new Date().toISOString();
    const db = drizzle(this.env.DATABASE, { schema });

    await db
      .update(schema.nodes)
      .set({
        status: 'sleeping',
        healthStatus: 'unhealthy',
        errorMessage: null,
        updatedAt: now,
      })
      .where(eq(schema.nodes.id, config.nodeId));

    await db
      .update(schema.workspaces)
      .set({
        status: 'sleeping',
        errorMessage: null,
        updatedAt: now,
      })
      .where(eq(schema.workspaces.id, config.workspaceId));

    await db
      .update(schema.agentSessions)
      .set({
        status: 'sleeping',
        errorMessage: null,
        updatedAt: now,
      })
      .where(eq(schema.agentSessions.workspaceId, config.workspaceId));

    log.info('vm_agent_container_runtime_sleeping', {
      nodeId: config.nodeId,
      workspaceId: config.workspaceId,
      status: 'sleeping',
      message,
    });
  }

  private async markRuntimeEnded(status: Exclude<LifecycleStatus, 'launching' | 'running' | 'stopping' | 'sleeping'>, message: string): Promise<void> {
    const config = await this.ctx.storage.get<VmAgentContainerLaunchConfig>('launchConfig');
    if (!config) {
      return;
    }

    const now = new Date().toISOString();
    const db = drizzle(this.env.DATABASE, { schema });
    const workspaceStatus = status === 'stopped' ? 'stopped' : 'error';
    const agentStatus = status === 'stopped' ? 'stopped' : 'error';
    const nodeStatus = status === 'stopped' ? 'stopped' : 'error';

    await db
      .update(schema.nodes)
      .set({
        status: nodeStatus,
        healthStatus: 'unhealthy',
        errorMessage: status === 'stopped' ? null : message,
        updatedAt: now,
      })
      .where(eq(schema.nodes.id, config.nodeId));

    await db
      .update(schema.workspaces)
      .set({
        status: workspaceStatus,
        errorMessage: status === 'stopped' ? null : message,
        updatedAt: now,
      })
      .where(eq(schema.workspaces.id, config.workspaceId));

    await db
      .update(schema.agentSessions)
      .set({
        status: agentStatus,
        stoppedAt: now,
        errorMessage: status === 'stopped' ? null : message,
        updatedAt: now,
      })
      .where(eq(schema.agentSessions.workspaceId, config.workspaceId));

    log.warn('vm_agent_container_runtime_ended', {
      nodeId: config.nodeId,
      workspaceId: config.workspaceId,
      status,
      message,
    });
  }
}
