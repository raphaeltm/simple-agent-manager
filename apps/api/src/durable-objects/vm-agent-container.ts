import { Container, switchPort } from '@cloudflare/containers';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';

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
const SLEEPING_RESPONSE = 'Container is asleep; wake/rehydrate is not implemented yet.';

export class VmAgentContainer extends Container<Env> {
  defaultPort = 8080;
  requiredPorts = [8080];
  sleepAfter = DEFAULT_CF_CONTAINER_SLEEP_AFTER;
  enableInternet = true;

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
    const state = await this.getState();
    const lifecycleStatus = await this.ctx.storage.get<LifecycleStatus>('lifecycleStatus');
    if (lifecycleStatus === 'sleeping') {
      // Phase 3 of idea 01KX4KSXEXQMP41KS34TW9EN01 will replace this temporary
      // response with wake/rehydrate before proxying the request.
      return new Response(SLEEPING_RESPONSE, { status: 503 });
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
    const state = await this.getState();
    const lifecycleStatus = await this.ctx.storage.get<LifecycleStatus>('lifecycleStatus');
    if (lifecycleStatus === 'sleeping') {
      // Phase 3 of idea 01KX4KSXEXQMP41KS34TW9EN01 will replace this temporary
      // response with wake/rehydrate before proxying the request.
      return new Response(SLEEPING_RESPONSE, { status: 503 });
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
