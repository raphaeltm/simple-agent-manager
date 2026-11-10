/**
 * Authorization decisions for the box's frps server plugin (Login, NewProxy, Ping).
 *
 * frps is the only party that holds per-node tunnel listeners, and it asks SAM before every
 * login, every proxy registration and every heartbeat. SAM answers from values IT stored:
 *
 * 1. the presented credential's SHA-256 equals the lease row's `credential_hash`
 *    (constant-time), for the exact (node id, incarnation) the frpc claims;
 * 2. the lease is `active` and its incarnation is the node row's live incarnation of a managed
 *    reverse-tunnel VM that is not being torn down;
 * 3. on NewProxy, the proxy is the node's one `tcp` proxy and binds exactly the leased port.
 *
 * A node holding a valid credential for itself therefore cannot bind another node's port,
 * claim another node's identity, or keep a released lease alive: Ping re-runs 1-2, so frps
 * drops a session within one heartbeat of the lease being released. Anything malformed,
 * unknown or unsupported is refused (fail closed).
 */
import { REVERSE_TUNNEL_PROXY_NAME } from '@simple-agent-manager/cloud-init';
import * as v from 'valibot';

import type { Env } from '../env';
import { constantTimeEqual } from '../lib/constant-time';
import { log } from '../lib/logger';
import { hashReverseTunnelCredential } from './node-reverse-tunnel-config';

export type FrpsPluginOp = 'Login' | 'NewProxy' | 'Ping';
export const FRPS_PLUGIN_OPS: readonly FrpsPluginOp[] = ['Login', 'NewProxy', 'Ping'];

export type FrpsPluginDecision = { allow: true } | { allow: false; reason: string; code: string };

const BoundedString = v.pipe(v.string(), v.minLength(1), v.maxLength(256));
const MetasSchema = v.object({
  node_id: BoundedString,
  incarnation: BoundedString,
  credential: BoundedString,
});
const UserSchema = v.object({ user: BoundedString, metas: MetasSchema });
const LoginContentSchema = v.object({ user: BoundedString, metas: MetasSchema });
const NewProxyContentSchema = v.object({
  user: UserSchema,
  proxy_name: BoundedString,
  proxy_type: BoundedString,
  remote_port: v.optional(v.number()),
});
const PingContentSchema = v.object({ user: UserSchema });
const BodySchema = v.object({ content: v.unknown() });

interface LeaseAuthorityRow {
  leaseId: string;
  port: number;
  credentialHash: string;
  leaseStatus: string;
  nodeStatus: string | null;
  nodeRuntime: string | null;
  nodeClass: string | null;
  nodeTransport: string | null;
  nodeIncarnation: string | null;
  nodeTerminatedAt: string | null;
}

const NODE_TEARDOWN_STATUSES = new Set(['deleted', 'stopped', 'destroying']);

function refuse(code: string, reason: string): FrpsPluginDecision {
  return { allow: false, code, reason };
}

interface ClaimedIdentity {
  user: string;
  nodeId: string;
  incarnation: string;
  credential: string;
}

function parseIdentity(
  op: FrpsPluginOp,
  content: unknown
): { identity: ClaimedIdentity; proxy?: v.InferOutput<typeof NewProxyContentSchema> } | null {
  if (op === 'Login') {
    const parsed = v.safeParse(LoginContentSchema, content);
    if (!parsed.success) return null;
    const { user, metas } = parsed.output;
    return {
      identity: {
        user,
        nodeId: metas.node_id,
        incarnation: metas.incarnation,
        credential: metas.credential,
      },
    };
  }
  if (op === 'NewProxy') {
    const parsed = v.safeParse(NewProxyContentSchema, content);
    if (!parsed.success) return null;
    const { user } = parsed.output;
    return {
      identity: {
        user: user.user,
        nodeId: user.metas.node_id,
        incarnation: user.metas.incarnation,
        credential: user.metas.credential,
      },
      proxy: parsed.output,
    };
  }
  const parsed = v.safeParse(PingContentSchema, content);
  if (!parsed.success) return null;
  const { user } = parsed.output;
  return {
    identity: {
      user: user.user,
      nodeId: user.metas.node_id,
      incarnation: user.metas.incarnation,
      credential: user.metas.credential,
    },
  };
}

async function readLeaseAuthority(
  env: Pick<Env, 'DATABASE'>,
  nodeId: string,
  incarnation: string
): Promise<LeaseAuthorityRow | null> {
  return await env.DATABASE.prepare(
    `SELECT l.id AS leaseId, l.port AS port, l.credential_hash AS credentialHash,
            l.status AS leaseStatus, n.status AS nodeStatus, n.runtime AS nodeRuntime,
            n.node_class AS nodeClass, n.transport AS nodeTransport,
            n.runtime_incarnation_id AS nodeIncarnation,
            n.runtime_termination_confirmed_at AS nodeTerminatedAt
       FROM node_reverse_tunnel_leases l
       LEFT JOIN nodes n ON n.id = l.node_id
      WHERE l.node_id = ? AND l.runtime_incarnation_id = ?`
  )
    .bind(nodeId, incarnation)
    .first<LeaseAuthorityRow>();
}

/** Decide one frps plugin request. Never throws for bad input; D1 failures propagate. */
export async function authorizeFrpsPluginRequest(
  env: Pick<Env, 'DATABASE'>,
  op: string | undefined,
  body: unknown
): Promise<FrpsPluginDecision> {
  if (!op || !(FRPS_PLUGIN_OPS as readonly string[]).includes(op)) {
    return refuse('unsupported_op', 'operation not handled by SAM');
  }
  const pluginOp = op as FrpsPluginOp;
  const envelope = v.safeParse(BodySchema, body);
  const parsed = envelope.success ? parseIdentity(pluginOp, envelope.output.content) : null;
  if (!parsed) return logged(pluginOp, null, refuse('malformed', 'malformed plugin request'));
  const { identity, proxy } = parsed;

  // frps names proxies `<user>.<name>`; binding user to the claimed node id keeps that name
  // (and frp's per-user bookkeeping) tied to the identity the credential proves.
  if (identity.user !== identity.nodeId) {
    return logged(pluginOp, identity, refuse('identity_mismatch', 'user must equal node id'));
  }

  const lease = await readLeaseAuthority(env, identity.nodeId, identity.incarnation);
  // Hash even when no lease exists so a miss and a wrong credential take the same path.
  const presentedHash = await hashReverseTunnelCredential(identity.credential);
  if (!lease || !constantTimeEqual(presentedHash, lease.credentialHash)) {
    return logged(pluginOp, identity, refuse('bad_credential', 'invalid node credential'));
  }
  if (lease.leaseStatus !== 'active') {
    return logged(pluginOp, identity, refuse('lease_released', 'node lease is released'));
  }
  if (
    lease.nodeIncarnation !== identity.incarnation ||
    lease.nodeTerminatedAt !== null ||
    lease.nodeRuntime !== 'vm' ||
    lease.nodeClass !== 'managed' ||
    lease.nodeTransport !== 'reverse-tunnel' ||
    !lease.nodeStatus ||
    NODE_TEARDOWN_STATUSES.has(lease.nodeStatus)
  ) {
    return logged(pluginOp, identity, refuse('node_not_live', 'node incarnation is not live'));
  }

  if (pluginOp === 'NewProxy' && proxy) {
    if (proxy.proxy_type !== 'tcp') {
      return logged(pluginOp, identity, refuse('proxy_type', 'only one tcp proxy is allowed'));
    }
    if (proxy.proxy_name !== `${identity.nodeId}.${REVERSE_TUNNEL_PROXY_NAME}`) {
      return logged(pluginOp, identity, refuse('proxy_name', 'proxy name is not the node agent'));
    }
    if (proxy.remote_port !== lease.port) {
      return logged(
        pluginOp,
        identity,
        refuse('port_not_leased', 'remote port is not leased to this node')
      );
    }
  }
  if (pluginOp !== 'Ping') {
    log.info('node_reverse_tunnel.plugin_allowed', {
      op: pluginOp,
      nodeId: identity.nodeId,
      runtimeIncarnationId: identity.incarnation,
      leaseId: lease.leaseId,
      port: lease.port,
    });
  }
  return { allow: true };
}

function logged(
  op: FrpsPluginOp,
  identity: ClaimedIdentity | null,
  decision: FrpsPluginDecision
): FrpsPluginDecision {
  if (!decision.allow) {
    log.warn('node_reverse_tunnel.plugin_refused', {
      op,
      claimedNodeId: identity?.nodeId ?? null,
      claimedIncarnation: identity?.incarnation ?? null,
      code: decision.code,
      action: 'rejected',
    });
  }
  return decision;
}
