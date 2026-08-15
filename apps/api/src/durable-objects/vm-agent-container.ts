// FILE SIZE EXCEPTION: Durable Object recovery state machine — method groups are already extracted into vm-agent-container-{recovery,runtime,lifecycle,active-work}.ts; the remaining class body is the interlocking mutex-guarded lifecycle critical sections (rule 45), which must stay reviewable as one unit. See .claude/rules/18-file-size-limits.md
import { Container, switchPort } from '@cloudflare/containers';

import type { Env } from '../env';
import { log } from '../lib/logger';
import { maybeJsonRecord } from '../lib/runtime-validation';
import { signCallbackToken, signNodeCallbackToken, signNodeManagementToken } from '../services/jwt';
import {
  ACTIVE_WORK_KEY,
  type ActiveWorkRuntime,
  type ActiveWorkState,
  endActiveWork,
  renewActiveWork,
  startActiveWork,
} from './vm-agent-container-active-work';
import {
  inspectStoredVmAgentContainerLifecycle,
  type VmAgentContainerLifecycleInspection,
  type VmAgentContainerLifecycleStatus,
} from './vm-agent-container-lifecycle';
import {
  loadRuntimeRecoveryContext,
  persistRuntimeRecovered,
  persistRuntimeRecovering,
  persistRuntimeRecoveryFailed,
  RUNTIME_RECOVERING_MESSAGE,
  RUNTIME_RECOVERY_DEGRADED_MESSAGE,
  RUNTIME_REQUEST_INTERRUPTED_MESSAGE,
  RUNTIME_STOPPED_MESSAGE,
  type RuntimeRecoveryCause,
  type RuntimeRecoveryCode,
  type RuntimeRecoveryState,
  type RuntimeRecoveryTarget,
  type RuntimeRecoveryTrigger,
  toRuntimeRecoveryTarget,
} from './vm-agent-container-recovery';
import {
  interruptedRuntimeRequestResponse as interruptedRequestResponse,
  isMissingSessionHostResponse,
  isMutatingRuntimeRequest as isMutatingRequest,
  persistRuntimeEnded,
  persistRuntimeSleeping,
  probeLiveRuntimeSession,
  resolveRuntimeSettings,
  runtimeRecoveryResponse as recoveryResponse,
  runtimeResultResponse as resultResponse,
} from './vm-agent-container-runtime';

export const DEFAULT_CF_CONTAINER_SLEEP_AFTER = '1h';
export const DEFAULT_CF_CONTAINER_PORT_READY_TIMEOUT_MS = 30_000;
export const DEFAULT_CF_CONTAINER_ACTIVE_WORK_MAX_MS = 2 * 60 * 60 * 1000;
export const DEFAULT_CF_CONTAINER_KEEPALIVE_RENEW_INTERVAL_MS = 5 * 60 * 1000;
export const DEFAULT_CF_CONTAINER_RECOVERY_MAX_ATTEMPTS = 2;
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

export interface VmAgentContainerRecoveryResult {
  ok: boolean;
  status: 'running' | 'recovering' | 'degraded' | 'stopped';
  code?: RuntimeRecoveryCode;
  message?: string;
}
type LifecycleStatus = VmAgentContainerLifecycleStatus;

const RECOVERY_STATE_KEY = 'runtimeRecovery';
const KEEPALIVE_CALLBACK = 'renewActiveWorkKeepalive';
function stoppedRecoveryResult(): VmAgentContainerRecoveryResult {
  return {
    ok: false,
    status: 'stopped',
    code: 'RUNTIME_STOPPED',
    message: RUNTIME_STOPPED_MESSAGE,
  };
}

export class VmAgentContainer extends Container<Env> {
  defaultPort = 8080;
  requiredPorts = [8080];
  sleepAfter = DEFAULT_CF_CONTAINER_SLEEP_AFTER;
  enableInternet = true;

  private wakeChain: Promise<unknown> = Promise.resolve();
  private lifecycleChain: Promise<unknown> = Promise.resolve();

  constructor(ctx: DurableObjectState<Record<string, never>>, env: Env) {
    super(ctx, env);
    const configuredPort = Number.parseInt(
      env.CF_CONTAINER_VM_AGENT_PORT || env.SANDBOX_VM_AGENT_PORT || '',
      10
    );
    if (Number.isFinite(configuredPort) && configuredPort > 0) {
      this.defaultPort = configuredPort;
      this.requiredPorts = [configuredPort];
    }
    this.sleepAfter =
      env.CF_CONTAINER_SLEEP_AFTER || env.SANDBOX_SLEEP_AFTER || DEFAULT_CF_CONTAINER_SLEEP_AFTER;
  }

  async launch(
    config: VmAgentContainerLaunchConfig,
    secrets: VmAgentContainerLaunchSecrets
  ): Promise<void> {
    await this.ctx.storage.put('launchConfig', config);
    await this.ctx.storage.put('lifecycleStatus', 'launching' satisfies LifecycleStatus);
    await this.ctx.storage.delete(ACTIVE_WORK_KEY);
    await this.ctx.storage.delete(RECOVERY_STATE_KEY);
    await this.clearKeepaliveSchedule();

    try {
      await this.startRuntime(config, secrets);
      await this.ctx.storage.put('lifecycleStatus', 'running' satisfies LifecycleStatus);
    } catch (error) {
      await this.ctx.storage.put('lifecycleStatus', 'error' satisfies LifecycleStatus);
      throw error;
    }
  }

  async proxyHttp(request: Request, port?: number): Promise<Response> {
    const ready = await this.prepareForRequest();
    if (!ready.ok) return resultResponse(ready);

    const state = await this.getState();
    if (state.status === 'stopped' || state.status === 'stopped_with_code') {
      const recovery = await this.beginUnexpectedRecovery({
        trigger: 'request',
        cause: { kind: 'transport_interrupted', errorName: 'container_stopped' },
        promptDisposition: isMutatingRequest(request) ? 'manual_retry' : 'none',
      });
      if (!recovery) {
        return recoveryResponse('RUNTIME_STOPPED', RUNTIME_STOPPED_MESSAGE, 410);
      }
      return interruptedRequestResponse(request);
    }

    try {
      const response = await this.containerFetch(request, port ?? this.defaultPort);
      if (await isMissingSessionHostResponse(response)) {
        await this.beginUnexpectedRecovery({
          trigger: 'request',
          cause: { kind: 'missing_session_host', httpStatus: response.status },
          promptDisposition: isMutatingRequest(request) ? 'manual_retry' : 'none',
        });
        return interruptedRequestResponse(request);
      }
      return response;
    } catch (error) {
      await this.beginUnexpectedRecovery({
        trigger: 'request',
        cause: {
          kind: 'transport_interrupted',
          errorName: error instanceof Error ? error.name : 'unknown',
        },
        promptDisposition: isMutatingRequest(request) ? 'manual_retry' : 'none',
      });
      return interruptedRequestResponse(request);
    }
  }

  override async fetch(request: Request): Promise<Response> {
    const ready = await this.prepareForRequest();
    if (!ready.ok) return resultResponse(ready);

    const state = await this.getState();
    if (state.status === 'stopped' || state.status === 'stopped_with_code') {
      await this.beginUnexpectedRecovery({
        trigger: 'request',
        cause: { kind: 'transport_interrupted', errorName: 'container_stopped' },
        promptDisposition: 'none',
      });
      return recoveryResponse('RUNTIME_RECOVERING', RUNTIME_RECOVERING_MESSAGE, 503);
    }

    try {
      return await super.fetch(switchPort(request, this.defaultPort));
    } catch (error) {
      await this.beginUnexpectedRecovery({
        trigger: 'request',
        cause: {
          kind: 'transport_interrupted',
          errorName: error instanceof Error ? error.name : 'unknown',
        },
        promptDisposition: 'none',
      });
      return recoveryResponse('RUNTIME_RECOVERING', RUNTIME_RECOVERING_MESSAGE, 503);
    }
  }

  async resumeRuntime(agentSessionId?: string): Promise<VmAgentContainerRecoveryResult> {
    const lifecycle = await this.ctx.storage.get<LifecycleStatus>('lifecycleStatus');
    if (lifecycle === 'running') {
      const config = await this.ctx.storage.get<VmAgentContainerLaunchConfig>('launchConfig');
      const context = config
        ? await loadRuntimeRecoveryContext(this.env, {
            workspaceId: config.workspaceId,
            preferredAgentSessionId: agentSessionId,
          })
        : null;
      if (!config || !context) {
        return {
          ok: false,
          status: 'degraded',
          code: 'RUNTIME_RECOVERY_DEGRADED',
          message: RUNTIME_RECOVERY_DEGRADED_MESSAGE,
        };
      }
      try {
        const live = await probeLiveRuntimeSession({
          env: this.env,
          userId: context.userId,
          nodeId: config.nodeId,
          workspaceId: config.workspaceId,
          agentSessionId: context.agentSessionId,
          vmAgentPort: config.vmAgentPort,
          containerFetch: (request, port) => this.containerFetch(request, port),
        });
        if (live) {
          const reconciled = await this.withLifecycleLock(async () => {
            const current = await this.ctx.storage.get<LifecycleStatus>('lifecycleStatus');
            if (current !== 'running') return false;
            await persistRuntimeRecovered(
              this.env,
              toRuntimeRecoveryTarget(config, context),
              'none'
            );
            return true;
          });
          if (reconciled) return { ok: true, status: 'running' };
          return this.ensureAwake();
        }
        await this.beginUnexpectedRecovery({
          trigger: 'request',
          cause: { kind: 'missing_session_host', httpStatus: 404 },
          promptDisposition: 'none',
        });
      } catch (error) {
        await this.beginUnexpectedRecovery({
          trigger: 'request',
          cause: {
            kind: 'transport_interrupted',
            errorName: error instanceof Error ? error.name : 'unknown',
          },
          promptDisposition: 'none',
        });
      }
    }
    return this.ensureAwake();
  }

  async markRequestInterrupted(input: {
    method: string;
    errorName: string;
  }): Promise<VmAgentContainerRecoveryResult> {
    const mutating = !['GET', 'HEAD', 'OPTIONS'].includes(input.method.toUpperCase());
    const state = await this.beginUnexpectedRecovery({
      trigger: 'request',
      cause: { kind: 'transport_interrupted', errorName: input.errorName },
      promptDisposition: mutating ? 'manual_retry' : 'none',
    });
    if (!state) {
      const status = await this.ctx.storage.get<LifecycleStatus>('lifecycleStatus');
      if (status === 'stopped' || status === 'stopping') {
        return stoppedRecoveryResult();
      }
    }
    return {
      ok: false,
      status: 'recovering',
      code: mutating ? 'RUNTIME_REQUEST_INTERRUPTED' : 'RUNTIME_RECOVERING',
      message: mutating ? RUNTIME_REQUEST_INTERRUPTED_MESSAGE : RUNTIME_RECOVERING_MESSAGE,
    };
  }

  async stopForUser(): Promise<void> {
    await this.markActiveWorkEnded('user_stop');
    await this.withLifecycleLock(async () => {
      await this.ctx.storage.put('lifecycleStatus', 'stopping' satisfies LifecycleStatus);
      await this.ctx.storage.delete(RECOVERY_STATE_KEY);
    });
    await this.stop();
  }

  async sleepForUser(): Promise<void> {
    await this.markActiveWorkEnded('user_sleep');
    await this.ctx.storage.put('lifecycleStatus', 'sleeping' satisfies LifecycleStatus);
    await this.stop();
  }

  async destroyForUser(): Promise<void> {
    await this.markActiveWorkEnded('user_destroy');
    await this.withLifecycleLock(async () => {
      await this.ctx.storage.put('lifecycleStatus', 'stopping' satisfies LifecycleStatus);
      await this.ctx.storage.delete(RECOVERY_STATE_KEY);
    });
    await this.destroy();
  }

  async markActiveWorkStarted(input: {
    workspaceId: string;
    agentSessionId: string;
    reason: string;
  }): Promise<void> {
    const config = await this.ctx.storage.get<VmAgentContainerLaunchConfig>('launchConfig');
    await startActiveWork(this.activeWorkRuntime(), config?.nodeId ?? input.workspaceId, input);
  }

  async markActiveWorkEnded(reason: string): Promise<void> {
    await endActiveWork(this.activeWorkRuntime(), reason);
  }

  async inspectLifecycle(): Promise<VmAgentContainerLifecycleInspection> {
    return inspectStoredVmAgentContainerLifecycle(
      this.ctx.storage,
      RECOVERY_STATE_KEY,
      ACTIVE_WORK_KEY
    );
  }

  async renewActiveWorkKeepalive(): Promise<void> {
    await renewActiveWork(this.activeWorkRuntime());
  }

  override async onStart(): Promise<void> {
    log.info('vm_agent_container_runtime_started', {});
  }

  override async onStop(params: {
    exitCode: number;
    reason: 'exit' | 'runtime_signal';
  }): Promise<void> {
    const status = await this.ctx.storage.get<LifecycleStatus>('lifecycleStatus');
    if (
      status === 'expired' ||
      status === 'sleeping' ||
      status === 'recovering' ||
      status === 'waking' ||
      status === 'restoring' ||
      status === 'degraded' ||
      status === 'stopped'
    ) {
      return;
    }
    if (status === 'stopping') {
      await this.markRuntimeEnded('stopped', 'Container stopped by user request');
      await this.ctx.storage.put('lifecycleStatus', 'stopped' satisfies LifecycleStatus);
      return;
    }
    if (status === 'launching') {
      await this.markRuntimeEnded('error', 'Instant runtime failed during initial launch.');
      await this.ctx.storage.put('lifecycleStatus', 'error' satisfies LifecycleStatus);
      return;
    }

    await this.beginUnexpectedRecovery({
      trigger: 'stop',
      cause: {
        kind: 'container_stop',
        reason: params.reason,
        exitCode: params.exitCode,
      },
      promptDisposition: 'none',
    });
  }

  override async onActivityExpired(): Promise<void> {
    const activeWork = await this.ctx.storage.get<ActiveWorkState>(ACTIVE_WORK_KEY);
    if (activeWork?.status === 'active' && Date.now() < activeWork.deadlineAt) {
      await this.renewActiveWorkKeepalive();
      return;
    }
    // Close the request gate before crossing D1/ProjectData boundaries. A
    // follow-up accepted after this point remains in durable delivery instead
    // of racing the final snapshot and being cut off by stop().
    await this.ctx.storage.put('lifecycleStatus', 'sleep-preparing' satisfies LifecycleStatus);
    let sleepResult: 'sleeping' | 'retry' | 'aborted' = 'retry';
    try {
      sleepResult = await this.markRuntimeSleeping(
        'Container idle timeout expired; container is sleeping.'
      );
    } catch (error) {
      log.warn('vm_agent_container_sleep_commit_failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if (sleepResult !== 'sleeping') {
      // Fail closed: the container remains physically live. Keep the request
      // gate closed for a durable roll-forward, but reopen it when the attempt
      // was cancelled before the point of no return (for example by a prompt).
      if (sleepResult === 'aborted') {
        await this.ctx.storage.put('lifecycleStatus', 'running' satisfies LifecycleStatus);
      }
      await this.renewActivityTimeout();
      return;
    }
    await this.ctx.storage.put('lifecycleStatus', 'sleeping' satisfies LifecycleStatus);
    await this.stop();
  }

  override async onError(error: unknown): Promise<void> {
    const status = await this.ctx.storage.get<LifecycleStatus>('lifecycleStatus');
    if (status === 'stopping') {
      await this.markRuntimeEnded('stopped', 'Container stopped by user request');
      await this.ctx.storage.put('lifecycleStatus', 'stopped' satisfies LifecycleStatus);
      return;
    }
    if (status === 'launching') {
      await this.markRuntimeEnded('error', 'Instant runtime failed during initial launch.');
      await this.ctx.storage.put('lifecycleStatus', 'error' satisfies LifecycleStatus);
      return;
    }
    if (status === 'stopped' || status === 'sleeping' || status === 'expired') return;

    await this.beginUnexpectedRecovery({
      trigger: 'error',
      cause: {
        kind: 'container_error',
        errorName: error instanceof Error ? error.name : 'unknown',
      },
      promptDisposition: 'none',
    });
  }

  private async prepareForRequest(): Promise<VmAgentContainerRecoveryResult> {
    const status = await this.ctx.storage.get<LifecycleStatus>('lifecycleStatus');
    if (status === 'running' || status === 'launching') {
      return { ok: true, status: 'running' };
    }
    if (status === 'sleep-preparing') {
      return {
        ok: false,
        status: 'recovering',
        code: 'RUNTIME_RECOVERING',
        message: RUNTIME_RECOVERING_MESSAGE,
      };
    }
    if (status === 'stopping' || status === 'stopped') {
      return stoppedRecoveryResult();
    }
    return this.ensureAwake();
  }

  private async ensureAwake(): Promise<VmAgentContainerRecoveryResult> {
    const run = this.wakeChain.then(async () => {
      let status = await this.ctx.storage.get<LifecycleStatus>('lifecycleStatus');
      if (status === 'running' || status === 'launching') {
        return { ok: true, status: 'running' } satisfies VmAgentContainerRecoveryResult;
      }
      if (status === 'stopping' || status === 'stopped') {
        return stoppedRecoveryResult();
      }

      let recovery: RuntimeRecoveryState | null | undefined =
        await this.ctx.storage.get(RECOVERY_STATE_KEY);
      if (!recovery) {
        const trigger: RuntimeRecoveryTrigger = status === 'sleeping' ? 'idle' : 'error';
        const cause: RuntimeRecoveryCause =
          status === 'sleeping'
            ? { kind: 'idle_sleep' }
            : { kind: 'container_error', errorName: 'legacy_terminal_state' };
        recovery = await this.beginUnexpectedRecovery({
          trigger,
          cause,
          promptDisposition: 'none',
        });
        status = await this.ctx.storage.get<LifecycleStatus>('lifecycleStatus');
      }

      // A concurrent stopForUser()/destroyForUser() runs on the same
      // lifecycleChain as beginUnexpectedRecovery above, so an explicit stop can
      // land between beginUnexpectedRecovery returning and this unlocked
      // continuation — flipping lifecycleStatus to 'stopping' and deleting the
      // recovery record. 'stopping' is terminal exactly like 'stopped'; both must
      // short-circuit here so we never re-arm recovery or wake a container the
      // user just stopped ("explicit stop is terminal, never recover").
      if (status === 'stopping' || status === 'stopped') {
        return stoppedRecoveryResult();
      }
      if (!recovery) {
        return {
          ok: false,
          status: 'degraded',
          code: 'RUNTIME_RECOVERY_DEGRADED',
          message: RUNTIME_RECOVERY_DEGRADED_MESSAGE,
        } satisfies VmAgentContainerRecoveryResult;
      }

      // Once recovery is exhausted, exhaustRecovery() has already reconciled D1
      // and set lifecycleStatus 'error'. Return the same sanitized degraded result
      // without re-running the full reconciliation batch on every later request.
      if (recovery.phase === 'exhausted') {
        return {
          ok: false,
          status: 'degraded',
          code: 'RUNTIME_RECOVERY_DEGRADED',
          message: RUNTIME_RECOVERY_DEGRADED_MESSAGE,
        } satisfies VmAgentContainerRecoveryResult;
      }

      if (recovery.attempts >= this.getRuntimeSettings().recoveryMaxAttempts) {
        return this.exhaustRecovery(recovery);
      }

      recovery = {
        ...recovery,
        phase: 'waking',
        attempts: recovery.attempts + 1,
        updatedAt: Date.now(),
      };
      await this.ctx.storage.put(RECOVERY_STATE_KEY, recovery);
      await this.ctx.storage.put('lifecycleStatus', 'waking' satisfies LifecycleStatus);
      return this.wakeFromSnapshot(recovery);
    });
    this.wakeChain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private async beginUnexpectedRecovery(input: {
    trigger: RuntimeRecoveryTrigger;
    cause: RuntimeRecoveryCause;
    promptDisposition: RuntimeRecoveryState['promptDisposition'];
  }): Promise<RuntimeRecoveryState | null> {
    return this.withLifecycleLock(async () => {
      const lifecycle = await this.ctx.storage.get<LifecycleStatus>('lifecycleStatus');
      if (lifecycle === 'stopping' || lifecycle === 'stopped' || lifecycle === 'expired') {
        return null;
      }

      const existing = await this.ctx.storage.get<RuntimeRecoveryState>(RECOVERY_STATE_KEY);
      if (existing) {
        if (
          input.promptDisposition === 'manual_retry' &&
          existing.promptDisposition !== 'manual_retry'
        ) {
          const promoted = {
            ...existing,
            promptDisposition: 'manual_retry' as const,
            updatedAt: Date.now(),
          };
          await this.ctx.storage.put(RECOVERY_STATE_KEY, promoted);
          return promoted;
        }
        return existing;
      }

      const config = await this.ctx.storage.get<VmAgentContainerLaunchConfig>('launchConfig');
      if (!config) return null;
      const activeWork = await this.ctx.storage.get<ActiveWorkState>(ACTIVE_WORK_KEY);
      const context = await loadRuntimeRecoveryContext(this.env, {
        workspaceId: config.workspaceId,
        preferredAgentSessionId: activeWork?.agentSessionId,
      });
      if (!context) return null;

      const now = Date.now();
      const recovery: RuntimeRecoveryState = {
        version: 1,
        phase: 'pending',
        trigger: input.trigger,
        cause: input.cause,
        attempts: 0,
        promptDisposition: input.promptDisposition,
        agentSessionId: context.agentSessionId,
        startedAt: now,
        updatedAt: now,
      };
      await this.ctx.storage.put(RECOVERY_STATE_KEY, recovery);
      await this.ctx.storage.put('lifecycleStatus', 'recovering' satisfies LifecycleStatus);
      await this.clearKeepaliveSchedule();
      await persistRuntimeRecovering(this.env, toRuntimeRecoveryTarget(config, context));
      log.warn('vm_agent_container_recovery_started', {
        nodeId: config.nodeId,
        workspaceId: config.workspaceId,
        agentSessionId: context.agentSessionId,
        trigger: input.trigger,
        cause: input.cause,
        promptDisposition: input.promptDisposition,
      });
      return recovery;
    });
  }

  private async wakeFromSnapshot(
    recovery: RuntimeRecoveryState
  ): Promise<VmAgentContainerRecoveryResult> {
    const config = await this.ctx.storage.get<VmAgentContainerLaunchConfig>('launchConfig');
    if (!config) return this.degradeRecovery(recovery, 'launch');

    // loadRuntimeRecoveryContext reads D1; a query failure must degrade through the
    // sanitized recovery path, not escape as an uncaught 500. It sits outside the
    // restore try below, so guard it explicitly here.
    let context: Awaited<ReturnType<typeof loadRuntimeRecoveryContext>>;
    try {
      context = await loadRuntimeRecoveryContext(this.env, {
        workspaceId: config.workspaceId,
        preferredAgentSessionId: recovery.agentSessionId,
      });
    } catch (error) {
      log.warn('vm_agent_container_recovery_context_failed', {
        nodeId: config.nodeId,
        workspaceId: config.workspaceId,
        errorName: error instanceof Error ? error.name : 'unknown',
      });
      return this.degradeRecovery(recovery, 'unexpected');
    }
    if (!context) return this.degradeRecovery(recovery, 'unexpected');
    const target = toRuntimeRecoveryTarget(config, context);

    try {
      const nodeCallbackToken = await signNodeCallbackToken(config.nodeId, this.env);
      await this.startRuntime(config, { nodeCallbackToken });
    } catch (error) {
      log.warn('vm_agent_container_recovery_launch_failed', {
        nodeId: config.nodeId,
        workspaceId: config.workspaceId,
        errorName: error instanceof Error ? error.name : 'unknown',
      });
      return this.degradeRecovery(recovery, 'launch', target);
    }

    const restoring = { ...recovery, phase: 'restoring' as const, updatedAt: Date.now() };
    await this.ctx.storage.put(RECOVERY_STATE_KEY, restoring);
    await this.ctx.storage.put('lifecycleStatus', 'restoring' satisfies LifecycleStatus);

    try {
      const workspaceCallbackToken = await signCallbackToken(config.workspaceId, this.env);
      const { token } = await signNodeManagementToken(
        context.userId,
        config.nodeId,
        config.workspaceId,
        this.env
      );
      const restoreUrl = new URL(
        `http://localhost:${config.vmAgentPort}/workspaces/${config.workspaceId}/agent-sessions/${context.agentSessionId}/restore`
      );
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
            chatSessionId: context.chatSessionId,
            runtime: 'cf-container',
            agentType: context.agentType,
            workspaceCallbackToken,
          }),
        }),
        config.vmAgentPort
      );
      const restoreBody = await restoreResponse.text().catch(() => '');
      if (!restoreResponse.ok) {
        return this.degradeRecovery(restoring, 'restore_http', target, restoreResponse.status);
      }
      let restoreStatus = '';
      try {
        const parsedRaw = JSON.parse(restoreBody) as unknown;
        const parsed = maybeJsonRecord(parsedRaw);
        restoreStatus = parsed && typeof parsed.status === 'string' ? parsed.status : '';
      } catch {
        // An explicit restored status is required before D1 can become running.
      }
      if (restoreStatus !== 'restored') {
        return this.degradeRecovery(restoring, 'restore_status', target);
      }

      const completed = await this.withLifecycleLock(async () => {
        const lifecycle = await this.ctx.storage.get<LifecycleStatus>('lifecycleStatus');
        if (lifecycle === 'stopping' || lifecycle === 'stopped') return false;
        await persistRuntimeRecovered(this.env, target, restoring.promptDisposition);
        await this.ctx.storage.delete(RECOVERY_STATE_KEY);
        await this.ctx.storage.put('lifecycleStatus', 'running' satisfies LifecycleStatus);
        return true;
      });
      if (!completed) {
        // An explicit stop crossed the restore after startRuntime() already
        // launched a fresh container. Tear it down so the just-stopped session
        // does not leak compute until sleepAfter. this.stop() is idempotent/safe
        // if stopForUser() already issued it.
        await this.stop().catch(() => undefined);
        return stoppedRecoveryResult();
      }
      log.info('vm_agent_container_recovery_completed', {
        nodeId: config.nodeId,
        workspaceId: config.workspaceId,
        agentSessionId: context.agentSessionId,
        attempts: restoring.attempts,
        promptDisposition: restoring.promptDisposition,
      });
      return { ok: true, status: 'running' };
    } catch (error) {
      log.warn('vm_agent_container_recovery_restore_failed', {
        nodeId: config.nodeId,
        workspaceId: config.workspaceId,
        errorName: error instanceof Error ? error.name : 'unknown',
      });
      return this.degradeRecovery(restoring, 'unexpected', target);
    }
  }

  private async degradeRecovery(
    recovery: RuntimeRecoveryState,
    kind: NonNullable<RuntimeRecoveryState['lastFailure']>['kind'],
    target?: RuntimeRecoveryTarget,
    httpStatus?: number
  ): Promise<VmAgentContainerRecoveryResult> {
    const degraded: RuntimeRecoveryState = {
      ...recovery,
      phase: 'degraded',
      updatedAt: Date.now(),
      lastFailure: { kind, ...(httpStatus === undefined ? {} : { httpStatus }) },
    };
    const applied = await this.withLifecycleLock(async () => {
      const lifecycle = await this.ctx.storage.get<LifecycleStatus>('lifecycleStatus');
      if (lifecycle === 'stopping' || lifecycle === 'stopped') return false;
      await this.ctx.storage.put(RECOVERY_STATE_KEY, degraded);
      await this.ctx.storage.put('lifecycleStatus', 'degraded' satisfies LifecycleStatus);
      return true;
    });
    if (!applied) {
      // A stop crossed the wake after startRuntime() launched a container (the
      // restore_http / restore_status / restore-catch degrade calls all run
      // post-launch). Tear it down before returning terminal. Idempotent/safe if
      // stopForUser() already stopped it.
      await this.stop().catch(() => undefined);
      return stoppedRecoveryResult();
    }
    await this.stop().catch(() => undefined);

    if (degraded.attempts >= this.getRuntimeSettings().recoveryMaxAttempts) {
      return this.exhaustRecovery(degraded, target);
    }
    return {
      ok: false,
      status: 'degraded',
      code: 'RUNTIME_RECOVERY_DEGRADED',
      message: RUNTIME_RECOVERY_DEGRADED_MESSAGE,
    };
  }

  private async exhaustRecovery(
    recovery: RuntimeRecoveryState,
    providedTarget?: RuntimeRecoveryTarget
  ): Promise<VmAgentContainerRecoveryResult> {
    const applied = await this.withLifecycleLock(async () => {
      const lifecycle = await this.ctx.storage.get<LifecycleStatus>('lifecycleStatus');
      if (lifecycle === 'stopping' || lifecycle === 'stopped') return false;
      const config = await this.ctx.storage.get<VmAgentContainerLaunchConfig>('launchConfig');
      let target = providedTarget;
      if (!target && config) {
        const context = await loadRuntimeRecoveryContext(this.env, {
          workspaceId: config.workspaceId,
          preferredAgentSessionId: recovery.agentSessionId,
        });
        if (context) target = toRuntimeRecoveryTarget(config, context);
      }
      const exhausted = { ...recovery, phase: 'exhausted' as const, updatedAt: Date.now() };
      await this.ctx.storage.put(RECOVERY_STATE_KEY, exhausted);
      await this.ctx.storage.put('lifecycleStatus', 'error' satisfies LifecycleStatus);
      if (target) await persistRuntimeRecoveryFailed(this.env, target);
      return true;
    });
    if (!applied) {
      // A stop crossed exhaustion. If a fresh container was launched earlier in
      // this wake, tear it down before returning terminal. Idempotent/safe if
      // stopForUser() already stopped it.
      await this.stop().catch(() => undefined);
      return stoppedRecoveryResult();
    }
    return {
      ok: false,
      status: 'degraded',
      code: 'RUNTIME_RECOVERY_DEGRADED',
      message: RUNTIME_RECOVERY_DEGRADED_MESSAGE,
    };
  }

  private async startRuntime(
    config: VmAgentContainerLaunchConfig,
    secrets: VmAgentContainerLaunchSecrets
  ): Promise<void> {
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
          ...(this.env.SESSION_SNAPSHOT_OPERATION_TIMEOUT
            ? {
                SESSION_SNAPSHOT_OPERATION_TIMEOUT: this.env.SESSION_SNAPSHOT_OPERATION_TIMEOUT,
              }
            : {}),
          ...(this.env.SESSION_SNAPSHOT_PROGRESS_REPORT_INTERVAL
            ? {
                SESSION_SNAPSHOT_PROGRESS_REPORT_INTERVAL:
                  this.env.SESSION_SNAPSHOT_PROGRESS_REPORT_INTERVAL,
              }
            : {}),
          ...(this.env.SESSION_SNAPSHOT_PROGRESS_REPORT_TIMEOUT
            ? {
                SESSION_SNAPSHOT_PROGRESS_REPORT_TIMEOUT:
                  this.env.SESSION_SNAPSHOT_PROGRESS_REPORT_TIMEOUT,
              }
            : {}),
          ...(this.env.CF_CONTAINER_CLONE_FILTER
            ? { STANDALONE_CLONE_FILTER: this.env.CF_CONTAINER_CLONE_FILTER }
            : {}),
        },
        labels: {
          nodeId: config.nodeId,
          workspaceId: config.workspaceId,
          runtime: 'cf-container',
        },
      },
      cancellationOptions: { portReadyTimeoutMS: this.getRuntimeSettings().portReadyTimeoutMs },
    });
  }

  private withLifecycleLock<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.lifecycleChain.then(operation);
    this.lifecycleChain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private activeWorkRuntime(): ActiveWorkRuntime {
    const settings = this.getRuntimeSettings();
    return {
      storage: this.ctx.storage,
      activeWorkMaxMs: settings.activeWorkMaxMs,
      renewIntervalMs: settings.keepaliveRenewIntervalMs,
      renewActivityTimeout: () => this.renewActivityTimeout(),
      replaceSchedule: (delayMs) => this.replaceKeepaliveSchedule(delayMs),
      clearSchedule: () => this.clearKeepaliveSchedule(),
    };
  }

  private getRuntimeSettings() {
    return resolveRuntimeSettings(this.env, {
      portReadyTimeoutMs: DEFAULT_CF_CONTAINER_PORT_READY_TIMEOUT_MS,
      activeWorkMaxMs: DEFAULT_CF_CONTAINER_ACTIVE_WORK_MAX_MS,
      keepaliveRenewIntervalMs: DEFAULT_CF_CONTAINER_KEEPALIVE_RENEW_INTERVAL_MS,
      recoveryMaxAttempts: DEFAULT_CF_CONTAINER_RECOVERY_MAX_ATTEMPTS,
    });
  }

  private async replaceKeepaliveSchedule(delayMs: number): Promise<void> {
    await this.clearKeepaliveSchedule();
    await this.schedule(Math.max(1, Math.ceil(delayMs / 1000)), KEEPALIVE_CALLBACK);
  }

  private async clearKeepaliveSchedule(): Promise<void> {
    await this.deleteSchedules(KEEPALIVE_CALLBACK);
  }

  private async markRuntimeSleeping(message: string): Promise<'sleeping' | 'retry' | 'aborted'> {
    const config = await this.ctx.storage.get<VmAgentContainerLaunchConfig>('launchConfig');
    if (!config) return 'aborted';
    const { drizzle } = await import('drizzle-orm/d1');
    const schema = await import('../db/schema');
    const {
      beginSessionSnapshotStopping,
      claimSessionSnapshotSleep,
      deferSessionSnapshotStopping,
      failSessionSnapshotSleepBeforeTeardown,
      finalizeSessionSnapshotSleeping,
      getRestorableSessionSnapshot,
      isSessionSnapshotSleepReleasable,
      verifySessionSnapshotArtifactsForSleep,
    } = await import('../services/session-snapshots');
    const db = drizzle(this.env.DATABASE, { schema });
    const snapshot = await getRestorableSessionSnapshot(db, config.chatSessionId);
    const snapshotStatus = snapshot?.status ?? null;
    const snapshotDegradation = snapshot?.degradation ?? null;
    if (!isSessionSnapshotSleepReleasable(snapshot)) {
      log.warn('vm_agent_container_sleep_preserved_without_snapshot', {
        nodeId: config.nodeId,
        workspaceId: config.workspaceId,
        snapshotStatus,
        snapshotDegradation,
      });
      return 'aborted';
    }
    const claimId = crypto.randomUUID();
    let pointOfNoReturn = snapshot.sleepStatus === 'sleeping' && Boolean(snapshot.sleepingAt);
    if (!pointOfNoReturn) {
      // Another owner (normally the scheduled VM-neutral sleep transaction) is
      // already preparing/stopping this runtime. It will call sleepForUser()
      // after its own verified commit; do not race or reuse its claim.
      if (snapshot.sleepStatus === 'preparing' || snapshot.sleepStatus === 'stopping')
        return 'retry';
      const claim = await claimSessionSnapshotSleep(db, this.env, {
        chatSessionId: config.chatSessionId,
        claimId,
        force: true,
      });
      if (claim.status !== 'claimed' || claim.phase !== 'preparing') {
        const winner = await getRestorableSessionSnapshot(db, config.chatSessionId);
        return winner?.sleepStatus === 'preparing' || winner?.sleepStatus === 'stopping'
          ? 'retry'
          : 'aborted';
      }
    }
    try {
      if (!pointOfNoReturn) {
        if (!(await verifySessionSnapshotArtifactsForSleep(this.env, snapshot))) {
          throw new Error('Container snapshot artifacts failed durable R2 verification');
        }
        if (!(await beginSessionSnapshotStopping(db, config.chatSessionId, claimId))) {
          throw new Error('Container sleep claim was cancelled before teardown');
        }
        pointOfNoReturn = true;
      }
      await this.markActiveWorkEnded('container_idle_sleeping');
      const projectDataService = await import('../services/project-data');
      // Each write is idempotent. Once `stopping` is durable, any interruption
      // rolls forward from the scheduled sweeper; the request gate stays closed.
      await projectDataService.sleepSession(this.env, config.projectId, config.chatSessionId);
      await persistRuntimeSleeping(this.env, config);
      if (!(snapshot.sleepStatus === 'sleeping' && snapshot.sleepingAt)) {
        const sleepWarning =
          snapshot.status === 'degraded'
            ? `Workspace slept with degraded snapshot (${snapshot.degradation})`
            : null;
        if (
          !(await finalizeSessionSnapshotSleeping(
            db,
            this.env,
            config.chatSessionId,
            claimId,
            new Date(),
            { sleepWarning }
          ))
        ) {
          throw new Error('Container sleep finalization lost its durable claim');
        }
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      let retryRequired = pointOfNoReturn;
      if (pointOfNoReturn) {
        await deferSessionSnapshotStopping(db, this.env, config.chatSessionId, claimId, detail);
      } else {
        await failSessionSnapshotSleepBeforeTeardown(
          db,
          this.env,
          config.chatSessionId,
          claimId,
          detail
        );
        const winner = await getRestorableSessionSnapshot(db, config.chatSessionId);
        retryRequired =
          winner?.sleepStatus === 'preparing' ||
          winner?.sleepStatus === 'stopping' ||
          (winner?.sleepStatus === 'sleeping' && Boolean(winner.sleepingAt));
      }
      log.warn('vm_agent_container_sleep_transaction_deferred', {
        nodeId: config.nodeId,
        workspaceId: config.workspaceId,
        pointOfNoReturn: retryRequired,
        error: detail,
      });
      return retryRequired ? 'retry' : 'aborted';
    }
    log.info('vm_agent_container_runtime_sleeping', {
      nodeId: config.nodeId,
      workspaceId: config.workspaceId,
      message,
    });
    return 'sleeping';
  }

  private async markRuntimeEnded(status: 'stopped' | 'error', message: string): Promise<void> {
    const config = await this.ctx.storage.get<VmAgentContainerLaunchConfig>('launchConfig');
    if (!config) return;
    await persistRuntimeEnded(this.env, config, status, message);
    log.warn('vm_agent_container_runtime_ended', {
      nodeId: config.nodeId,
      workspaceId: config.workspaceId,
      status,
    });
  }
}
