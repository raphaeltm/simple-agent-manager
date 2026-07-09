import { Container, switchPort } from '@cloudflare/containers';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';

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

type LifecycleStatus = 'launching' | 'running' | 'stopping' | 'stopped' | 'expired' | 'error';

export class VmAgentContainer extends Container<Env> {
  defaultPort = 8080;
  requiredPorts = [8080];
  sleepAfter = '10m';
  enableInternet = true;

  constructor(ctx: DurableObjectState<Record<string, never>>, env: Env) {
    super(ctx, env);
    const configuredPort = Number.parseInt(env.CF_CONTAINER_VM_AGENT_PORT || env.SANDBOX_VM_AGENT_PORT || '', 10);
    if (Number.isFinite(configuredPort) && configuredPort > 0) {
      this.defaultPort = configuredPort;
      this.requiredPorts = [configuredPort];
    }
    this.sleepAfter = env.CF_CONTAINER_SLEEP_AFTER || env.SANDBOX_SLEEP_AFTER || '10m';
  }

  async launch(
    config: VmAgentContainerLaunchConfig,
    secrets: VmAgentContainerLaunchSecrets
  ): Promise<void> {
    await this.ctx.storage.put('launchConfig', config);
    await this.ctx.storage.put('lifecycleStatus', 'launching' satisfies LifecycleStatus);

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
    if (state.status === 'stopped' || state.status === 'stopped_with_code') {
      return new Response('Container is stopped; create a new instant session.', { status: 410 });
    }
    return this.containerFetch(request, port ?? this.defaultPort);
  }

  async stopForUser(): Promise<void> {
    await this.ctx.storage.put('lifecycleStatus', 'stopping' satisfies LifecycleStatus);
    await this.stop();
  }

  async destroyForUser(): Promise<void> {
    await this.ctx.storage.put('lifecycleStatus', 'stopping' satisfies LifecycleStatus);
    await this.destroy();
  }

  override async fetch(request: Request): Promise<Response> {
    const state = await this.getState();
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
    if (status === 'expired') {
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
    await this.markRuntimeEnded('expired', 'Container idle timeout expired; start a new instant session.');
    await this.ctx.storage.put('lifecycleStatus', 'expired' satisfies LifecycleStatus);
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

  private async markRuntimeEnded(status: Exclude<LifecycleStatus, 'launching' | 'running' | 'stopping'>, message: string): Promise<void> {
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
