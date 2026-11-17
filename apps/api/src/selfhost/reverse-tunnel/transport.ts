/** Imported only by the self-host build, which supplies L18's frpc cloud-init renderer. */
import type { CloudInitVariables } from '@simple-agent-manager/cloud-init';

import { installNodeTransportExtension } from '../../services/node-transport-extension';
import { nodeTunnelBootVariables } from '../../services/node-tunnel-config';
import { isReverseTunnelInstallation } from './env';
import { releaseNodeReverseTunnelLeases, releaseUnallocatedReverseTunnelLease } from './leases';
import { ensureNodeReverseTunnelForProvisioning } from './provisioning';

export interface ReverseTunnelBootVariables extends CloudInitVariables {
  reverseTunnelCredential: string;
  reverseTunnelRemotePort: string;
  reverseTunnelLocalPort: string;
}
export function installReverseTunnelTransport(
  render: (variables: ReverseTunnelBootVariables) => string
): void {
  if (typeof render !== 'function') throw new Error('Reverse tunnel requires its self-host boot renderer');
  installNodeTransportExtension({
    transport: 'reverse-tunnel',
    select: (node) => node.runtime === 'vm' && node.nodeClass === 'managed' && node.nodeRole === 'workspace'
      ? 'reverse-tunnel' : null,
    prepare: async (env, owner) => {
      if (!isReverseTunnelInstallation(env)) throw new Error('Reverse tunnel is disabled');
      const lease = await ensureNodeReverseTunnelForProvisioning(env, owner);
      return (variables) => render({
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
  });
}
