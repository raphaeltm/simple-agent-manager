const REVERSE_TUNNEL_PROXY_NAME = 'sam-agent';
import * as v from 'valibot';

import { constantTimeEqual } from '../../lib/constant-time';
import { log } from '../../lib/logger';
import { deriveReverseTunnelRunId, hashReverseTunnelCredential } from './config';
import type { ReverseTunnelEnv as Env } from './env';

export type FrpsPluginOp = 'Login' | 'NewProxy' | 'Ping' | 'NewWorkConn';
export const FRPS_PLUGIN_OPS: readonly FrpsPluginOp[] = [
  'Login',
  'NewProxy',
  'Ping',
  'NewWorkConn',
];

export type FrpsPluginDecision = { allow: true; replacementContent?: Record<string, unknown> } | { allow: false; reason: string; code: string };

const BoundedString = v.pipe(v.string(), v.minLength(1), v.maxLength(256));
const MetasSchema = v.object({
  node_id: BoundedString,
  incarnation: BoundedString,
  credential: BoundedString,
});
const UserSchema = v.object({ user: BoundedString, metas: MetasSchema, run_id: BoundedString });
const LoginContentSchema = v.object({ user: BoundedString, metas: MetasSchema });
const NewProxyContentSchema = v.object({
  user: UserSchema,
  proxy_name: BoundedString,
  proxy_type: BoundedString,
  remote_port: v.optional(v.number()),
});
const PingContentSchema = v.object({ user: UserSchema });
const NewWorkConnContentSchema = v.object({
  user: v.object({ user: BoundedString, metas: MetasSchema, run_id: BoundedString }),
  run_id: BoundedString,
});
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
  nodeUser: string | null;
  leaseUser: string;
  nodeTerminatedAt: string | null;
}

const LeaseAuthoritySchema = v.object({
  leaseId: v.string(), port: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(65535)),
  credentialHash: v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/)), leaseStatus: v.string(),
  nodeStatus: v.nullable(v.string()), nodeRuntime: v.nullable(v.string()), nodeClass: v.nullable(v.string()),
  nodeTransport: v.nullable(v.string()), nodeIncarnation: v.nullable(v.string()),
  nodeTerminatedAt: v.nullable(v.string()), nodeUser: v.nullable(v.string()), leaseUser: v.string(),
});
/** Node statuses in which a node's tunnel identity is no longer honoured (also `app-route.ts`). */
export const NODE_TEARDOWN_STATUSES: ReadonlySet<string> = new Set(['deleted', 'stopped', 'destroying']);

function refuse(code: string, reason: string): FrpsPluginDecision {
  return { allow: false, code, reason };
}

interface ClaimedIdentity {
  user: string;
  nodeId: string;
  incarnation: string;
  credential: string;
  runId?: string;
}

function parseIdentity(
  op: FrpsPluginOp,
  content: unknown
): {
  identity: ClaimedIdentity;
  proxy?: v.InferOutput<typeof NewProxyContentSchema>;
    workConnRunIdMatches?: boolean;
} | null {
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
        runId: user.run_id,
      },
      proxy: parsed.output,
    };
  }
  if (op === 'NewWorkConn') {
    const parsed = v.safeParse(NewWorkConnContentSchema, content);
    if (!parsed.success) return null;
    const { user, run_id: runId } = parsed.output;
    return {
      identity: {
        user: user.user,
        nodeId: user.metas.node_id,
        incarnation: user.metas.incarnation,
        credential: user.metas.credential,
        runId: user.run_id,
      },
      workConnRunIdMatches: runId === user.run_id,
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
        runId: user.run_id,
    },
  };
}

async function readLeaseAuthority(
  env: Pick<Env, 'DATABASE'>,
  nodeId: string,
  incarnation: string
): Promise<LeaseAuthorityRow | null> {
  const row = await env.DATABASE.prepare(
    `SELECT l.id AS leaseId, l.port AS port, l.credential_hash AS credentialHash,
            l.status AS leaseStatus, n.status AS nodeStatus, n.runtime AS nodeRuntime,
            n.node_class AS nodeClass, n.transport AS nodeTransport,
            n.runtime_incarnation_id AS nodeIncarnation,
            n.user_id AS nodeUser, l.user_id AS leaseUser,
            n.runtime_termination_confirmed_at AS nodeTerminatedAt
       FROM node_reverse_tunnel_leases l
       LEFT JOIN nodes n ON n.id = l.node_id
      WHERE l.node_id = ? AND l.runtime_incarnation_id = ?`
  )
    .bind(nodeId, incarnation)
    .first<unknown>();
  const parsed = v.safeParse(LeaseAuthoritySchema, row);
  if (row && !parsed.success) log.warn('node_reverse_tunnel.invalid_authority', { nodeId, incarnation });
  return parsed.success ? parsed.output : null;
}

function isLiveLeaseNode(lease: LeaseAuthorityRow, incarnation: string): boolean {
  return (
    lease.nodeIncarnation === incarnation &&
    lease.nodeUser === lease.leaseUser &&
    lease.nodeTerminatedAt === null &&
    lease.nodeRuntime === 'vm' &&
    lease.nodeClass === 'managed' &&
    lease.nodeTransport === 'reverse-tunnel' &&
    !!lease.nodeStatus &&
    !NODE_TEARDOWN_STATUSES.has(lease.nodeStatus)
  );
}

function newProxyRefusal(
  proxy: v.InferOutput<typeof NewProxyContentSchema>,
  nodeId: string,
  port: number
): FrpsPluginDecision | null {
  if (proxy.proxy_type !== 'tcp') return refuse('proxy_type', 'only one tcp proxy is allowed');
  if (proxy.proxy_name !== `${nodeId}.${REVERSE_TUNNEL_PROXY_NAME}`) {
    return refuse('proxy_name', 'proxy name is not the node agent');
  }
  if (proxy.remote_port !== port) {
    return refuse('port_not_leased', 'remote port is not leased to this node');
  }
  return null;
}

async function leaseRefusal(
  env: Pick<Env, 'DATABASE'>,
  identity: ClaimedIdentity
): Promise<{ refusal: FrpsPluginDecision } | { lease: LeaseAuthorityRow }> {
  // frps names proxies `<user>.<name>`; binding user to the claimed node id keeps that name
  // (and frp's per-user bookkeeping) tied to the identity the credential proves.
  if (identity.user !== identity.nodeId) {
    return { refusal: refuse('identity_mismatch', 'user must equal node id') };
  }
  const lease = await readLeaseAuthority(env, identity.nodeId, identity.incarnation);
  // Hash even when no lease exists so a miss and a wrong credential take the same path.
  const presentedHash = await hashReverseTunnelCredential(identity.credential);
  if (!lease || !constantTimeEqual(presentedHash, lease.credentialHash)) {
    return { refusal: refuse('bad_credential', 'invalid node credential') };
  }
  if (lease.leaseStatus !== 'active') {
    return { refusal: refuse('lease_released', 'node lease is released') };
  }
  if (!isLiveLeaseNode(lease, identity.incarnation)) {
    return { refusal: refuse('node_not_live', 'node incarnation is not live') };
  }
  return { lease };
}

export async function authorizeFrpsPluginRequest(
  env: Pick<Env, 'DATABASE' | 'ENCRYPTION_KEY'>,
  op: string | undefined,
  body: unknown
): Promise<FrpsPluginDecision> {
  if (!op || !(FRPS_PLUGIN_OPS as readonly string[]).includes(op)) {
    return refuse('unsupported_op', 'operation not handled by SAM');
  }
  const pluginOp = op as FrpsPluginOp;
  const envelope = v.safeParse(BodySchema, body);
  const parsed = envelope.success ? parseIdentity(pluginOp, envelope.output.content) : null;
  if (!envelope.success || !parsed) return logged(pluginOp, null, refuse('malformed', 'malformed plugin request'));
  const { identity, proxy, workConnRunIdMatches } = parsed;
  if (workConnRunIdMatches === false) {
    return logged(pluginOp, identity, refuse('run_id_mismatch', 'work connection run id mismatch'));
  }

  const checked = await leaseRefusal(env, identity);
  if ('refusal' in checked) return logged(pluginOp, identity, checked.refusal);
  const { lease } = checked;
  const runId = await deriveReverseTunnelRunId(env, {
    leaseId: lease.leaseId, nodeId: identity.nodeId, runtimeIncarnationId: identity.incarnation,
  });
  if (pluginOp !== 'Login' && !constantTimeEqual(identity.runId ?? '', runId)) {
    return logged(pluginOp, identity, refuse('session_mismatch', 'control session identity mismatch'));
  }
  const proxyRefusal = proxy ? newProxyRefusal(proxy, identity.nodeId, lease.port) : null;
  if (proxyRefusal) return logged(pluginOp, identity, proxyRefusal);

  // Ping and NewWorkConn fire per heartbeat / per proxied connection: allowed ones are not logged.
  if (pluginOp === 'Login' || pluginOp === 'NewProxy') {
    log.info('node_reverse_tunnel.plugin_allowed', {
      op: pluginOp,
      nodeId: identity.nodeId,
      runtimeIncarnationId: identity.incarnation,
      leaseId: lease.leaseId,
      port: lease.port,
    });
  }
  // Preserve every frp Login field. The gateway MUST use unchange:false for this decision.
  return pluginOp === 'Login'
    ? { allow: true, replacementContent: { ...envelope.output.content as Record<string, unknown>, run_id: runId } }
    : { allow: true };
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
