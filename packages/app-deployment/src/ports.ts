/**
 * What app deployment needs from other areas of the worker. The worker builds
 * the implementations (`apps/api/src/app-deployment-ports/`) and passes them
 * in; this module never imports those areas directly.
 */
import type { Provider } from '@simple-agent-manager/providers';
import type { CredentialProvider } from '@simple-agent-manager/shared';
import type { drizzle } from 'drizzle-orm/d1';

/** Cloud provider resolution (project, then user, then platform credential). */
export interface DeploymentProviderPort {
  createProviderForUser(
    db: ReturnType<typeof drizzle>,
    userId: string,
    targetProvider?: CredentialProvider,
    projectId?: string | null
  ): Promise<{ provider: Provider; providerName: CredentialProvider } | null>;
}

/** Encrypts and decrypts deployment environment config values with the credential key. */
export interface DeploymentSecretCipher {
  encrypt(plaintext: string): Promise<{ ciphertext: string; iv: string }>;
  decrypt(ciphertext: string, iv: string): Promise<string>;
}

export type DeploymentPublishJobSettingName =
  | 'deployments.buildExecutor'
  | `deployments.builder${'DeadlineMs' | 'MaxConcurrent' | 'ProjectMaxConcurrent' | 'CapacityBackoffMs' | 'DrainLimit' | 'DaemonReadyTimeoutMs' | 'HeartbeatIntervalMs' | 'CallbackTimeoutMs' | 'CallbackAttempts' | 'CallbackRetryDelayMs'}`
  | `deployments.buildContext${'CollectionMode' | 'StartTimeoutMs' | 'MaxBytes' | 'CollectTimeoutMs' | 'UploadTtlSeconds' | 'RetentionHours' | 'CleanupBudgetMs' | 'CleanupPageSize'}`
  | 'deployments.publishJobStallMs'
  | 'deployments.publishJobDeadlineMs'
  | 'deployments.publishJobSweepLimit'
  | 'deployments.publishJobCancelTimeoutMs';

/** Reads admin-tunable deployment settings. */
export interface DeploymentSettingsPort {
  resolveSetting(name: DeploymentPublishJobSettingName): Promise<unknown>;
}

/** Asks the VM agent that runs a publish job to cancel it. */
export interface DeploymentPublishVmPort {
  cancelPublishJob(
    workspaceId: string,
    userId: string,
    nodeId: string,
    publishJobId: string,
    timeoutMs: number
  ): Promise<unknown>;
}

export interface DeploymentPublishJobLifecycleEvent {
  projectId: string;
  publishJobId: string;
  environmentId: string;
  status: string;
  terminal?: boolean | null;
  currentStep?: string | null;
  workspaceId?: string | null;
  nodeId?: string | null;
  taskId?: string | null;
  source: string;
  occurredAt?: string | number | null;
}

/** Records project lifecycle events. Implementations never throw. */
export interface DeploymentLifecyclePort {
  recordPublishJobLifecycleEventBestEffort(
    event: DeploymentPublishJobLifecycleEvent
  ): Promise<void>;
}

/** Everything the publish-job sweep and cancellation need. */
export interface DeploymentPublishJobPorts {
  settings: DeploymentSettingsPort;
  vm: DeploymentPublishVmPort;
  builder?: {
    stop(
      job: Pick<import('@simple-agent-manager/worker-core/schema').DeploymentPublishJobRow, 'id'>
    ): Promise<void>;
  };
  lifecycle: DeploymentLifecyclePort;
}

export interface BuildContextInterpolation {
  buildInterpolationEnv: Record<string, string>;
  secretInterpolationKeys: string[];
}

/** Source authentication and transport stay in the worker; context policy stays here. */
export interface BuildContextCollectionPorts {
  settings: DeploymentSettingsPort;
  source: {
    requestCollection(
      job: import('@simple-agent-manager/worker-core/schema').DeploymentPublishJobRow,
      body: BuildContextInterpolation & {
        publishJobId: string;
        attempt: number;
        shadow: boolean;
        workingDir: string | null;
        maxBytes: number;
        collectTimeoutMs: number;
      },
      timeoutMs: number
    ): Promise<Response>;
  };
}
