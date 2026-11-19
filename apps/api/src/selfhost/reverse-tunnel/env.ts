/** Self-host bootstrap settings. These never become Cloudflare Worker bindings. */
import type { Env } from '../../env';

export interface ReverseTunnelEnv extends Env {
  REVERSE_TUNNEL_GATEWAY_SECRET?: string;
  REVERSE_TUNNEL_GATEWAY_SECRET_ALTERNATE?: string;
  REVERSE_TUNNEL_PORT_RANGE_START?: string;
  REVERSE_TUNNEL_PORT_RANGE_END?: string;
  REVERSE_TUNNEL_HEARTBEAT_TIMEOUT_SECONDS?: string;
  REVERSE_TUNNEL_PORT_REUSE_MIN_AGE_SECONDS?: string;
}
export function isReverseTunnelInstallation(env: Pick<Env, 'VM_AGENT_TRANSPORT'>): boolean {
  return env.VM_AGENT_TRANSPORT?.trim() === 'reverse-tunnel';
}
