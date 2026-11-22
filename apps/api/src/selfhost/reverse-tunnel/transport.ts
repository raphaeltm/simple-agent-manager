/** Imported only by the self-host build, which supplies L18's frpc cloud-init renderer. */
import type { CloudInitVariables } from '@simple-agent-manager/cloud-init';

import { installNodeTransportExtension } from '../../services/node-transport-extension';
import { nodeTunnelBootVariables } from '../../services/node-tunnel-config';
import { reverseTunnelAppRouteAddress } from './app-route';
import { releaseNodeReverseTunnelLeases, releaseUnallocatedReverseTunnelLease } from './leases';
import { ensureNodeReverseTunnelForProvisioning } from './provisioning';
import { resolveReverseTunnelAgentOrigin } from './route';

export interface ReverseTunnelBootVariables extends CloudInitVariables {
  reverseTunnelCredential: string;
  reverseTunnelRemotePort: string;
  reverseTunnelLocalPort: string;
}
export function installReverseTunnelTransport(
  render: (variables: ReverseTunnelBootVariables) => string
): void {
  if (typeof render !== 'function')
    throw new Error('Reverse tunnel requires its self-host boot renderer');
  installNodeTransportExtension({
    transport: 'reverse-tunnel',
    // Workspace and deployment nodes alike: the tunnel carries a deployment node's control
    // channel and callbacks, and its app traffic too (`app-route.ts`), so it needs no public port.
    select: (node) =>
      node.runtime === 'vm' &&
      node.nodeClass === 'managed' &&
      (node.nodeRole === 'workspace' || node.nodeRole === 'deployment')
        ? 'reverse-tunnel'
        : null,
    prepare: async (env, owner) => {
      const lease = await ensureNodeReverseTunnelForProvisioning(env, owner);
      return (variables) =>
        render({
          ...variables,
          ...nodeTunnelBootVariables(env),
          // Cloudflared belongs only to the Cloudflare driver, not the shared listener timings.
          cloudflaredVersion: undefined,
          originCaCertificateUrl: undefined,
          reverseTunnelCredential: lease.credential,
          reverseTunnelRemotePort: String(lease.port),
          reverseTunnelLocalPort: lease.localPort,
        });
    },
    releaseUnallocated: releaseUnallocatedReverseTunnelLease,
    releaseNonLive: releaseNodeReverseTunnelLeases,
    resolveAgentOrigin: resolveReverseTunnelAgentOrigin,
    appRouteAddress: reverseTunnelAppRouteAddress,
  });
}
