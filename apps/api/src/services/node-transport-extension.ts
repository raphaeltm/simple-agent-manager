/** Build-owned transport adapter. Only the self-host entry installs an extension. */
import type { CloudInitVariables } from '@simple-agent-manager/cloud-init';
import type { NodeTransport } from '@simple-agent-manager/shared';

import type { Env } from '../env';

export type NodeBootRenderer = (variables: CloudInitVariables) => string;
export interface NodeTransportOwner {
  nodeId: string;
  userId: string;
  runtimeIncarnationId: string;
}
export interface NodeTransportExtension {
  transport: NodeTransport;
  select(node: { runtime: string; nodeClass: string; nodeRole?: string }): NodeTransport | null;
  prepare(env: Env, owner: NodeTransportOwner): Promise<NodeBootRenderer>;
  releaseUnallocated(env: Env, nodeId: string, incarnation: string, reason: string): Promise<unknown>;
  releaseNonLive(env: Env, nodeId: string, reason: string): Promise<unknown>;
}
let extension: NodeTransportExtension | undefined;

/** Called once at build entry initialization, before requests and DO dispatch. */
export function installNodeTransportExtension(value: NodeTransportExtension): void {
  if (extension && extension.transport !== value.transport) {
    throw new Error('A node transport extension is already installed');
  }
  extension = value;
}
export function nodeTransportExtension(transport?: string | null): NodeTransportExtension | undefined {
  return transport === undefined || transport === extension?.transport ? extension : undefined;
}

/** Stored transport owns ingress even before an external tunnel id is written. */
export function nodeHasTunnelIngress(node: { transport: string | null; tunnelId?: string | null }): boolean {
  return !!node.tunnelId || node.transport === 'cloudflare-tunnel' || node.transport === 'reverse-tunnel';
}
