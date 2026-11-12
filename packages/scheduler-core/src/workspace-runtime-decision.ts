import type { AgentProfileRuntime, CredentialSource } from '@simple-agent-manager/shared';

export type WorkspaceRuntime = AgentProfileRuntime;

export interface WorkspaceRuntimeDecisionInput {
  containerEnabled: boolean;
  explicitRuntime?: AgentProfileRuntime | null;
  credentialSource?: CredentialSource | null;
}

export interface WorkspaceRuntimeDecision {
  runtime: WorkspaceRuntime;
  reason:
    | 'sandbox-disabled'
    | 'explicit-vm'
    | 'explicit-cf-container'
    | 'user-cloud-credential'
    | 'project-cloud-credential'
    | 'zero-config';
}

export function decideWorkspaceRuntime(input: WorkspaceRuntimeDecisionInput): WorkspaceRuntimeDecision {
  if (!input.containerEnabled) {
    return { runtime: 'vm', reason: 'sandbox-disabled' };
  }

  if (input.explicitRuntime === 'vm') {
    return { runtime: 'vm', reason: 'explicit-vm' };
  }
  if (input.explicitRuntime === 'cf-container') {
    return { runtime: 'cf-container', reason: 'explicit-cf-container' };
  }

  if (input.credentialSource === 'user') {
    return { runtime: 'vm', reason: 'user-cloud-credential' };
  }
  if (input.credentialSource === 'project') {
    return { runtime: 'vm', reason: 'project-cloud-credential' };
  }

  return { runtime: 'cf-container', reason: 'zero-config' };
}
