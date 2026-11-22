/**
 * App ingress for deployment nodes on the reverse tunnel (self-host box only).
 *
 * A deployment node on the box has no public port and does no ACME. Its app hostnames
 * (`r<n>-<service>-<port>-<env>.apps.<BASE_DOMAIN>`) resolve to the box. The box's Caddy terminates
 * TLS with its own `*.apps.` wildcard and asks this decision (forward_auth,
 * `GET /api/self-host/gateway/app-route`) where to send each request. The answer names the node's
 * lease upstream (`127.0.0.1:<leasePort>`, frps) and the vm-agent URI
 * `/deployment/app-ingress/<hostname>/<path>`. It also carries a short-lived app-ingress token for
 * that node and hostname (`app-route-token.ts`), which Caddy sends in `X-SAM-Node-Authorization` so
 * the app's own Authorization header reaches the app untouched. The vm-agent re-checks the hostname against the routes it applied and
 * hands the request to its loopback-only Caddy (`packages/vm-agent/internal/server/app_ingress.go`).
 *
 * A hostname reaches a node only when ALL of these hold, read from D1 on every request:
 * - it is one label directly under `apps.<BASE_DOMAIN>`;
 * - the label's environment exists, is not stopping or stopped, and is bound to a node
 *   (`deployment_environments.node_id`); the node comes from that binding, never from the request;
 * - the environment's project and the node have the same owner;
 * - the hostname is exactly a route target of the environment's latest release or of its latest
 *   applied one (`readServableRouteHostnames`);
 * - the node is a managed VM deployment node on this transport, not being torn down, with an
 *   active lease on its current incarnation (`resolveReverseTunnelAgentOrigin`).
 * Every miss answers the same 404, so the decision never reveals which check failed.
 */
import {
  collectEnvironmentRouteHostnames,
  routeTargetOptions,
} from '@simple-agent-manager/app-deployment';
import * as v from 'valibot';

import { log } from '../../lib/logger';
import { NodeAgentRouteError } from '../../services/node-agent-route';
import { boxPublicIPv4, isBoxDnsEnabled } from '../dns';
import { appIngressToken } from './app-route-token';
import { NODE_TEARDOWN_STATUSES } from './authz';
import type { ReverseTunnelEnv as Env } from './env';
import { resolveReverseTunnelAgentOrigin } from './route';

/** Response headers the box's Caddy copies into the upstream request (Caddyfile, `*.apps` site). */
export const APP_ROUTE_HEADER = {
  upstream: 'X-SAM-Upstream',
  upstreamUri: 'X-SAM-Upstream-Uri',
  nodeAuthorization: 'X-SAM-Upstream-Node-Authorization',
  nodeId: 'X-SAM-Node-Id',
} as const;

/** The vm-agent route that carries app traffic (`server.go`, `handleDeploymentAppIngress`). */
export const APP_INGRESS_PATH_PREFIX = '/deployment/app-ingress';

/** `r<n>-<service>-<port>-<env id, lowercased>`; the environment part is the last segment. */
const APP_ROUTE_LABEL_RE = /^r[1-9][0-9]{0,3}-[a-z0-9-]+-[1-9][0-9]{0,4}-([a-z0-9]{1,40})$/;

/** Environments whose routes the node has removed or is removing. */
const ENVIRONMENT_ROUTES_GONE = new Set(['stopping', 'stopped']);

const BindingSchema = v.object({
  environmentId: v.string(),
  environmentStatus: v.string(),
  nodeId: v.string(),
  projectUser: v.string(),
  nodeUser: v.string(),
  nodeRole: v.nullable(v.string()),
  nodeStatus: v.nullable(v.string()),
  runtime: v.nullable(v.string()),
  nodeClass: v.nullable(v.string()),
  transport: v.nullable(v.string()),
});
type Binding = v.InferOutput<typeof BindingSchema>;

export type AppRouteDecision =
  | {
      allow: true;
      nodeId: string;
      upstream: string;
      upstreamUri: string;
      nodeAuthorization: string;
    }
  | { allow: false; status: 404 | 503; code: string };

/**
 * Where a reverse-tunnel deployment node's app-route records point (the extension's
 * `appRouteAddress`). With DNS on the box: the box's own address, required, since the records are
 * the only way the names resolve. Without it: null, because the operator's `*.SAM_DOMAIN` record
 * already resolves every `*.apps.` name to the box, and the Cloudflare API is not there to call.
 */
export function reverseTunnelAppRouteAddress(env: Env): string | null {
  if (!isBoxDnsEnabled(env)) return null;
  const address = boxPublicIPv4(env);
  if (!address) {
    throw new Error(
      'Deployment nodes on the reverse tunnel need SAM_DNS_PUBLIC_IPV4 (the box address their app routes resolve to)'
    );
  }
  return address;
}

/** The environment id a hostname names, or null when it is not one app-route label under apps. */
export function parseAppRouteHostname(env: Pick<Env, 'BASE_DOMAIN'>, host: string): string | null {
  const baseDomain = env.BASE_DOMAIN?.trim().toLowerCase();
  if (!baseDomain || host !== host.toLowerCase()) return null;
  const suffix = `.apps.${baseDomain}`;
  if (!host.endsWith(suffix)) return null;
  const label = host.slice(0, -suffix.length);
  if (label.length > 63) return null;
  const match = APP_ROUTE_LABEL_RE.exec(label);
  // Environment ids are ULIDs; hostnames carry them lowercased (buildRouteHostname).
  return match?.[1] ? match[1].toUpperCase() : null;
}

/**
 * True when the request path is one a browser sends: no dot segment, backslash or control
 * character in any encoding. The decision hands the path to Caddy's rewrite, and a path Caddy or
 * the agent could normalize must never be able to climb out of `/deployment/app-ingress/<host>`.
 */
export function isPlainAppPath(uri: string): boolean {
  if (!uri.startsWith('/')) return false;
  const path = uri.split(/[?#]/, 1)[0] ?? '';
  let decoded = path;
  for (let depth = 0; depth < 3; depth++) {
    let next: string;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      return false;
    }
    if (next === decoded) break;
    decoded = next;
  }
  for (const char of decoded) {
    const code = char.charCodeAt(0);
    if (char === '\\' || code < 0x20 || code === 0x7f) return false;
  }
  return !decoded.split('/').some((segment) => segment === '.' || segment === '..');
}

const ManifestRowSchema = v.object({ manifest: v.string() });

/**
 * Hostnames the environment may be serving: the routes of its latest release (what the node is
 * applying, or will apply) and of its latest applied release (what it runs while a newer release
 * applies, or after a failed apply fell back). The node's own applied routes are the final word
 * (`deploy.ActiveSitesServeHostname` in the agent), so admitting both never admits more than the node serves.
 * One read; a malformed manifest contributes no routes.
 */
async function readServableRouteHostnames(env: Env, environmentId: string): Promise<Set<string>> {
  const result = await env.DATABASE.prepare(
    `SELECT manifest FROM deployment_releases
      WHERE id IN (
        SELECT id FROM (SELECT id FROM deployment_releases WHERE environment_id = ?
                         ORDER BY version DESC LIMIT 1)
        UNION
        SELECT id FROM (SELECT id FROM deployment_releases WHERE environment_id = ?
                           AND status = 'applied' ORDER BY version DESC LIMIT 1)
      )`
  )
    .bind(environmentId, environmentId)
    .all<unknown>();
  const manifests: string[] = [];
  for (const row of result.results ?? []) {
    const parsed = v.safeParse(ManifestRowSchema, row);
    if (parsed.success) manifests.push(parsed.output.manifest);
    else log.warn('self_host_app_route.invalid_release_row', { environmentId });
  }
  return new Set(
    collectEnvironmentRouteHostnames(manifests, routeTargetOptions(env, environmentId))
  );
}

async function readBinding(env: Env, environmentId: string): Promise<Binding | null> {
  const row = await env.DATABASE.prepare(
    `SELECT e.id AS environmentId, e.status AS environmentStatus, e.node_id AS nodeId,
            p.user_id AS projectUser, n.user_id AS nodeUser, n.node_role AS nodeRole,
            n.status AS nodeStatus, n.runtime AS runtime, n.node_class AS nodeClass,
            n.transport AS transport
       FROM deployment_environments e
       JOIN projects p ON p.id = e.project_id
       JOIN nodes n ON n.id = e.node_id
      WHERE e.id = ?`
  )
    .bind(environmentId)
    .first<unknown>();
  if (!row) return null;
  const parsed = v.safeParse(BindingSchema, row);
  if (!parsed.success) {
    log.warn('self_host_app_route.invalid_binding', { environmentId });
    return null;
  }
  return parsed.output;
}

function bindingRefusal(binding: Binding): string | null {
  if (ENVIRONMENT_ROUTES_GONE.has(binding.environmentStatus)) return 'environment_stopped';
  if (binding.projectUser !== binding.nodeUser) return 'owner_mismatch';
  if (
    binding.nodeRole !== 'deployment' ||
    binding.runtime !== 'vm' ||
    binding.nodeClass !== 'managed' ||
    binding.transport !== 'reverse-tunnel'
  ) {
    return 'node_not_tunnel_deployment';
  }
  if (!binding.nodeStatus || NODE_TEARDOWN_STATUSES.has(binding.nodeStatus)) return 'node_not_live';
  return null;
}

function refuse(host: string, code: string, status: 404 | 503 = 404): AppRouteDecision {
  log.info('self_host_app_route.refused', { host: host.slice(0, 255), code, action: 'rejected' });
  return { allow: false, status, code };
}

/**
 * Decide one app request. `host` is the request's host (lowercase, no port) and `uri` its
 * path and query, both as Caddy received them.
 */
export async function authorizeAppRouteRequest(
  env: Env,
  host: string,
  uri: string
): Promise<AppRouteDecision> {
  const environmentId = parseAppRouteHostname(env, host);
  if (!environmentId || !isPlainAppPath(uri)) return refuse(host, 'not_an_app_route');
  const binding = await readBinding(env, environmentId);
  if (!binding) return refuse(host, 'no_environment_binding');
  const refusal = bindingRefusal(binding);
  if (refusal) return refuse(host, refusal);

  const hostnames = await readServableRouteHostnames(env, binding.environmentId);
  if (!hostnames.has(host)) return refuse(host, 'not_a_route');

  let origin: string;
  try {
    origin = await resolveReverseTunnelAgentOrigin(env, binding.nodeId);
  } catch (err) {
    if (err instanceof NodeAgentRouteError) return refuse(host, 'node_unreachable', 503);
    throw err;
  }
  const token = await appIngressToken(env, {
    userId: binding.nodeUser,
    nodeId: binding.nodeId,
    host,
  });
  return {
    allow: true,
    nodeId: binding.nodeId,
    upstream: new URL(origin).host,
    upstreamUri: `${APP_INGRESS_PATH_PREFIX}/${host}${uri}`,
    nodeAuthorization: `Bearer ${token}`,
  };
}

/** The forward_auth answer: 200 with the decision headers, or the refusal for Caddy to send. */
export function appRouteDecisionResponse(decision: AppRouteDecision): Response {
  if (!decision.allow) {
    const message = decision.status === 503 ? 'This app is not reachable right now' : 'Not found';
    return Response.json(
      { error: decision.status === 503 ? 'APP_UNAVAILABLE' : 'NOT_FOUND', message },
      { status: decision.status, headers: { 'Cache-Control': 'no-store' } }
    );
  }
  const headers = new Headers({ 'Cache-Control': 'no-store' });
  headers.set(APP_ROUTE_HEADER.upstream, decision.upstream);
  headers.set(APP_ROUTE_HEADER.upstreamUri, decision.upstreamUri);
  headers.set(APP_ROUTE_HEADER.nodeAuthorization, decision.nodeAuthorization);
  headers.set(APP_ROUTE_HEADER.nodeId, decision.nodeId);
  return new Response(null, { status: 200, headers });
}
