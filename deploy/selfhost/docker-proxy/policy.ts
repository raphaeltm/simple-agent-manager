/**
 * What celld may ask of the Docker daemon on a self-hosted box (guided credential login).
 *
 * celld needs the Docker Engine API to run the sign-in sandbox, and the raw socket is root on the
 * box: one `POST /containers/create` with `Privileged`, a `/:/host` bind or host networking
 * escapes every fence. This module is the whole decision of the socket proxy (`server.ts`): it
 * allows exactly the calls celld v0.6.3 makes for its container support
 * (`crates/celld/container.rs`), in exactly the shapes it makes them, and nothing else.
 *
 * - A sandbox container: an image the deploy built, the pinned OCI runtime (gVisor), every
 *   capability dropped, no-new-privileges, a PID/memory/CPU ceiling, one of celld's two fenced
 *   bridges, and no bind except the resolver file, whose source the proxy replaces with an
 *   operator-owned file (celld's own data dir could hold a symlink to any host path).
 * - The fence container: celld's one-shot `nft -f` of its own bridge rules. Image, command,
 *   rules (by hash), labels and host config must all match exactly; it is the only container
 *   that gets host networking and NET_ADMIN, and it can only install celld's fence.
 * - Lifecycle calls (start, wait, kill, inspect, logs, remove) only on containers that carry
 *   celld's node label and are one of those two shapes, addressed by their id after the check.
 * - exec only into a sandbox container; exec start/inspect only for exec ids this proxy created.
 * - Image inspect only for the allowed images. Image load, build, pull, tag, commit, volume,
 *   plugin, swarm and system calls are refused: the deploy builds both images on this box, so
 *   celld never needs to load one (a load could retag any image the stack runs).
 * - Only celld's two networks, created with exactly celld's options.
 *
 * Validated request bodies are re-serialised from the checked fields, so the daemon parses the
 * same object this module checked (Go's JSON decoder matches keys case-insensitively and keeps
 * the last duplicate; an unknown key here is a refusal, never a pass-through).
 *
 * Plain TypeScript with erasable syntax only: the proxy image runs it with Node's type stripping.
 */

/** The decision inputs written by `pnpm selfhost:deploy` to `.state/docker-proxy/policy.json`. */
import {
  CELLD_NETWORKS,
  CONTAINER_NAME,
  CONTAINER_REF,
  EXEC_ID,
  execCreate,
  fenceCreate,
  IMAGE_REF,
  isRecord,
  listFilters,
  networkCreate,
  onlyKeys,
  optionalBool,
  type ProxyPolicy,
  query,
  Refusal,
  refuse,
  sandboxCreate,
  SIGNAL,
  TRUE_FALSE,
  withQuery,
} from './shapes.ts';

export {
  CELLD_FENCE_CMD,
  CELLD_FENCE_RULES_SHA256,
  CELLD_NETWORKS,
  isRecord,
  parsePolicy,
  type ProxyPolicy,
} from './shapes.ts';

export interface ContainerFacts {
  id: string;
  labels: Record<string, string>;
  runtime: string;
  networkMode: string;
  privileged: boolean;
}

/** What the decision may ask of the daemon (read-only) and of the proxy's own state. */
export interface DecisionContext {
  policy: ProxyPolicy;
  inspectContainer(ref: string): Promise<ContainerFacts | null>;
  ownsExec(id: string): boolean;
}

export interface ProxyRequest {
  method: string;
  /** The request-target as received (origin form). */
  url: string;
  /** Parsed JSON body, or undefined when the request had none. */
  body: unknown;
  /** True when the client asked for a connection upgrade (`exec start` hijack). */
  upgrade: boolean;
}

export type Decision =
  | { allow: false; status: number; reason: string }
  | {
      allow: true;
      method: string;
      /** Path and query forwarded to the daemon, rebuilt from checked parts. */
      target: string;
      /** Canonical JSON body to forward, or null for none. */
      body: string | null;
      upgrade: boolean;
      /** Set on exec create: the proxy records the returned exec id. */
      recordsExec: boolean;
      /** Short route name for the audit log (no ids, no bodies). */
      route: string;
    };
function allow(
  method: string,
  route: string,
  target: string,
  body: unknown = null,
  extra: { upgrade?: boolean; recordsExec?: boolean } = {}
): Decision {
  return {
    allow: true,
    method,
    route,
    target,
    body: body === null ? null : JSON.stringify(body),
    upgrade: extra.upgrade ?? false,
    recordsExec: extra.recordsExec ?? false,
  };
}
/** A container is celld's when it has its node label and one of the two allowed shapes. */
function isCelldContainer(facts: ContainerFacts, policy: ProxyPolicy): 'sandbox' | 'fence' | null {
  if (!facts.labels['celld.node'] || facts.privileged) return null;
  if (facts.labels['celld.fence'] === '1') return facts.networkMode === 'host' ? 'fence' : null;
  if (facts.runtime === policy.runtime && facts.networkMode in CELLD_NETWORKS) return 'sandbox';
  return null;
}

async function ownedContainer(
  ref: string,
  context: DecisionContext,
  need: 'any' | 'sandbox'
): Promise<string> {
  if (!CONTAINER_REF.test(ref)) refuse('container reference is malformed');
  const facts = await context.inspectContainer(ref);
  // The same answer as the daemon's for a missing container, so celld's 404 paths still work.
  if (!facts) refuse('No such container', 404);
  const kind = isCelldContainer(facts, context.policy);
  if (!kind || (need === 'sandbox' && kind !== 'sandbox')) {
    refuse('container is not one of celld’s sandboxes');
  }
  return facts.id;
}
/** Decide one request. Never throws: every refusal is a 403 (or the daemon's own 404). */
export async function decide(request: ProxyRequest, context: DecisionContext): Promise<Decision> {
  try {
    return await route(request, context);
  } catch (error) {
    if (error instanceof Refusal)
      return { allow: false, status: error.status, reason: error.message };
    return { allow: false, status: 403, reason: 'request could not be checked' };
  }
}

async function route(request: ProxyRequest, context: DecisionContext): Promise<Decision> {
  const { method, body, upgrade } = request;
  if (!request.url.startsWith('/') || request.url.startsWith('//'))
    refuse('malformed request target');
  // WHATWG URL parsing resolves dot segments (including %2e) before matching, and the forwarded
  // target is rebuilt from what matched, so the daemon routes exactly what was checked.
  const url = new URL(request.url, 'http://docker');
  const path = url.pathname;
  if (path.includes('%') || path.includes('//'))
    refuse('encoded or empty path segments are not allowed');
  const noBody = (): void => {
    if (body !== undefined) refuse(`${method} ${path} takes no body`);
  };
  if (upgrade && !/^\/exec\/[^/]+\/start$/.test(path))
    refuse('upgrade is only allowed for exec start');

  if ((method === 'GET' || method === 'HEAD') && path === '/_ping') {
    noBody();
    query(url, {}, 'ping');
    return allow(method, 'ping', '/_ping');
  }

  if (method === 'GET' && path === '/containers/json') {
    noBody();
    const params = query(url, { all: TRUE_FALSE, filters: /^.{1,512}$/ }, 'list');
    const filters = params.get('filters');
    if (!filters || !listFilters(filters))
      refuse('list: only celld.node label filters are allowed');
    return allow(method, 'containers.list', withQuery(path, params));
  }

  if (method === 'POST' && path === '/containers/create') {
    const params = query(url, { name: CONTAINER_NAME }, 'create');
    const labels = isRecord(body) && isRecord(body.Labels) ? body.Labels : {};
    if (labels['celld.fence'] === '1') {
      if (params.has('name')) refuse('fence: celld creates its fence container unnamed');
      return allow(
        method,
        'containers.create.fence',
        path,
        await fenceCreate(body, context.policy)
      );
    }
    if (!params.has('name')) refuse('create: a sandbox container must have celld’s name');
    return allow(
      method,
      'containers.create.sandbox',
      withQuery(path, params),
      sandboxCreate(body, context.policy)
    );
  }

  const container = /^\/containers\/([^/]+)(?:\/([a-z]+))?$/.exec(path);
  if (container) {
    const [, ref, action] = container as unknown as [string, string, string | undefined];
    if (method === 'DELETE' && action === undefined) {
      noBody();
      const params = query(url, { force: TRUE_FALSE }, 'remove');
      const id = await ownedContainer(ref, context, 'any');
      return allow(method, 'containers.remove', withQuery(`/containers/${id}`, params));
    }
    if (method === 'GET' && (action === 'json' || action === 'logs')) {
      noBody();
      const params =
        action === 'json'
          ? query(url, {}, 'inspect')
          : query(url, { stdout: TRUE_FALSE, stderr: TRUE_FALSE }, 'logs');
      const id = await ownedContainer(ref, context, 'any');
      return allow(
        method,
        `containers.${action}`,
        withQuery(`/containers/${id}/${action}`, params)
      );
    }
    if (method === 'POST' && (action === 'start' || action === 'wait' || action === 'kill')) {
      noBody();
      const params =
        action === 'kill' ? query(url, { signal: SIGNAL }, 'kill') : query(url, {}, action);
      const id = await ownedContainer(ref, context, 'any');
      return allow(
        method,
        `containers.${action}`,
        withQuery(`/containers/${id}/${action}`, params)
      );
    }
    if (method === 'POST' && action === 'exec') {
      query(url, {}, 'exec');
      const id = await ownedContainer(ref, context, 'sandbox');
      return allow(method, 'containers.exec', `/containers/${id}/exec`, execCreate(body), {
        recordsExec: true,
      });
    }
    refuse(
      `${method} ${action ? `/containers/{id}/${action}` : '/containers/{id}'} is not allowed`
    );
  }

  const exec = /^\/exec\/([^/]+)\/(start|json)$/.exec(path);
  if (exec) {
    const [, id, action] = exec as unknown as [string, string, string];
    if (!EXEC_ID.test(id) || !context.ownsExec(id))
      refuse('exec was not created through this proxy');
    query(url, {}, 'exec');
    if (method === 'GET' && action === 'json') {
      noBody();
      return allow(method, 'exec.inspect', `/exec/${id}/json`);
    }
    if (method === 'POST' && action === 'start') {
      const start = onlyKeys(body ?? {}, ['Detach', 'Tty'], 'exec start');
      const out: Record<string, unknown> = {};
      for (const key of ['Detach', 'Tty']) {
        const value = optionalBool(start[key], `exec start: ${key}`);
        if (value !== undefined) out[key] = value;
      }
      return allow(method, 'exec.start', `/exec/${id}/start`, out, { upgrade });
    }
    refuse(`${method} /exec/{id}/${action} is not allowed`);
  }

  const image = /^\/images\/([^/]+)\/json$/.exec(path);
  if (image && method === 'GET') {
    noBody();
    query(url, {}, 'image');
    const ref = image[1] as string;
    const known = [...context.policy.sandboxImages, context.policy.fenceImage];
    if (!IMAGE_REF.test(ref) || !known.includes(ref)) refuse('image is not one the deploy built');
    return allow(method, 'images.inspect', `/images/${ref}/json`);
  }

  const network = /^\/networks\/([^/]+)$/.exec(path);
  if (method === 'POST' && path === '/networks/create') {
    query(url, {}, 'network');
    return allow(method, 'networks.create', path, networkCreate(body));
  }
  if (network && (method === 'GET' || method === 'DELETE')) {
    noBody();
    query(url, {}, 'network');
    const name = network[1] as string;
    if (!(name in CELLD_NETWORKS)) refuse('network is not one of celld’s');
    return allow(
      method,
      `networks.${method === 'GET' ? 'inspect' : 'remove'}`,
      `/networks/${name}`
    );
  }

  refuse(`${method} ${path} is not allowed`);
}
