/**
 * The proxy's own calls to the Docker daemon: inspect for ownership checks, the response
 * filters, and the stale-sandbox reaper. Erasable TypeScript (Node type stripping).
 */
import { request as httpRequest } from 'node:http';

import { type ContainerFacts, isCelldContainer, isRecord, type ProxyPolicy } from './policy.ts';

export const UPSTREAM = process.env.SAM_DOCKER_PROXY_UPSTREAM ?? '/var/run/docker.sock';

export function logEvent(event: string, fields: Record<string, unknown>): void {
  // Method, route, path and reason only: never a body (sandbox env can hold provider settings).
  console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...fields }));
}

/** One request to the daemon with the whole answer buffered (small JSON answers only). */
export function upstreamJson(
  method: string,
  path: string
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { socketPath: UPSTREAM, method, path, headers: { Host: 'docker' } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') })
        );
        res.on('error', reject);
      }
    );
    req.on('error', reject);
    req.end();
  });
}

export async function inspectContainer(ref: string): Promise<ContainerFacts | null> {
  const reply = await upstreamJson('GET', `/containers/${encodeURIComponent(ref)}/json`);
  if (reply.status === 404) return null;
  if (reply.status !== 200) throw new Error(`inspect answered ${reply.status}`);
  const info: unknown = JSON.parse(reply.body);
  const record = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {});
  const top = record(info);
  const config = record(top.Config);
  const host = record(top.HostConfig);
  const id = top.Id;
  if (typeof id !== 'string' || !/^[0-9a-f]{64}$/.test(id)) {
    throw new Error('inspect answered without an id');
  }
  const labels: Record<string, string> = {};
  for (const [key, value] of Object.entries(record(config.Labels))) {
    if (typeof value === 'string') labels[key] = value;
  }
  return {
    id,
    labels,
    runtime: typeof host.Runtime === 'string' ? host.Runtime : '',
    networkMode: typeof host.NetworkMode === 'string' ? host.NetworkMode : '',
    privileged: host.Privileged === true,
  };
}

function pick(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!isRecord(value)) return out;
  for (const key of keys) if (Object.hasOwn(value, key)) out[key] = value[key];
  return out;
}

/**
 * Inspect answers carry host layout (bind sources, overlay paths, log paths, PIDs of other
 * namespaces). celld reads only these fields (container.rs `inspect_running`, `address_of`,
 * `exec`, `ExecProcess::wait`, `ensure_image`), so only these go back.
 */
export const RESPONSE_FILTERS: Record<string, (answer: unknown) => unknown> = {
  'containers.json': (answer) => {
    const top = isRecord(answer) ? answer : {};
    const networks: Record<string, unknown> = {};
    const settings = isRecord(top.NetworkSettings) ? top.NetworkSettings : {};
    const raw = isRecord(settings.Networks) ? settings.Networks : {};
    for (const [name, network] of Object.entries(raw))
      networks[name] = pick(network, ['IPAddress']);
    return {
      ...pick(top, ['Id', 'Name']),
      State: pick(top.State, ['Running', 'Status', 'ExitCode']),
      NetworkSettings: { Networks: networks },
    };
  },
  'exec.inspect': (answer) => pick(answer, ['ID', 'Running', 'ExitCode', 'Pid']),
  'images.inspect': (answer) => pick(answer, ['Id']),
};

/**
 * celld gets a new node-session id every time it starts, and its start-up reap removes only
 * containers labelled with its own id, so a sandbox left by a celld that died stays running (with
 * whatever the sign-in CLI holds) until something removes it. This box runs one celld, so when
 * celld reaps for node X, every other celld *sandbox* (same checks as any lifecycle call: node
 * label, the pinned runtime, a celld bridge, not privileged) is a leftover of an earlier session.
 */
export async function reapStaleSandboxes(currentNode: string, policy: ProxyPolicy): Promise<void> {
  const filters = encodeURIComponent(JSON.stringify({ label: ['celld.node', 'celld.class'] }));
  const reply = await upstreamJson('GET', `/containers/json?all=true&filters=${filters}`);
  if (reply.status !== 200) return;
  const list: unknown = JSON.parse(reply.body);
  for (const entry of Array.isArray(list) ? list : []) {
    if (!isRecord(entry) || typeof entry.Id !== 'string' || !isRecord(entry.Labels)) continue;
    if (entry.Labels['celld.node'] === currentNode) continue;
    const facts = await inspectContainer(entry.Id);
    if (!facts || isCelldContainer(facts, policy) !== 'sandbox') continue;
    const removed = await upstreamJson('DELETE', `/containers/${facts.id}?force=true`);
    logEvent('reaped_stale_sandbox', {
      container: facts.id.slice(0, 12),
      node: String(facts.labels['celld.node']).slice(0, 64),
      status: removed.status,
    });
  }
}

/** The node celld is reaping for, from its own `GET /containers/json` label filter. */
export function reapingNode(url: string): string | null {
  const params = new URL(url, 'http://docker').searchParams;
  if (params.get('all') !== 'true') return null;
  try {
    const filters: unknown = JSON.parse(params.get('filters') ?? '');
    const label = isRecord(filters) && Array.isArray(filters.label) ? filters.label[0] : null;
    return typeof label === 'string' && label.startsWith('celld.node=')
      ? label.slice('celld.node='.length)
      : null;
  } catch {
    return null;
  }
}
