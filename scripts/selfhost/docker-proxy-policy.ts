/**
 * The policy file the Docker socket proxy enforces for celld (guided credential login).
 *
 * `pnpm selfhost:deploy` writes `<state dir>/docker-proxy/` with:
 * - `policy.json`: the two images celld may run (by the content reference celld tags them with),
 *   the runtime, the resource ceiling of the class's instance type, the hash of celld's fence
 *   rules, and where the sandbox resolver file lives (deploy/selfhost/docker-proxy/policy.ts);
 * - `container-resolv.conf`: the resolver file sandboxes get. It lives here, owned by the
 *   operator, rather than in celld's data dir: celld owns that directory, so a compromised celld
 *   could replace its own file with a symlink to any path on the host and have the daemon bind it.
 *
 * The image references are computed the way celld 0.6.3 computes them (`deploy.rs`
 * `resolve_image`): `celld-image:<sha256 of the image's {{json .RootFS.Layers}}{{json .Config}}>`.
 * The deploy builds both images before `celld deploy` (which then hits the build cache) and checks
 * afterwards that celld tagged exactly those references, so a divergence fails the deploy instead
 * of every sign-in.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CELLD_FENCE_RULES_SHA256,
  parsePolicy,
  type ProxyPolicy,
} from '../../deploy/selfhost/docker-proxy/policy.ts';
import { type GuidedLoginSettings, SANDBOX_IMAGE_DIR } from './guided-login.js';

/** celld 0.6.3 `FENCE_DOCKERFILE` (deploy.rs). */
export const CELLD_FENCE_DOCKERFILE = 'FROM alpine:3.20\nRUN apk add --no-cache nftables\n';

/** What celld asks the daemon to bind (`<CELLD_WATCH>/container-resolv.conf`, CELLD_WATCH=/var/lib/celld). */
export const CELLD_RESOLV_CONF_BIND = '/var/lib/celld/container-resolv.conf:/etc/resolv.conf:ro';

/** celld's own default resolvers for a container under a named runtime. */
export const SANDBOX_RESOLV_CONF = 'nameserver 1.1.1.1\nnameserver 1.0.0.1\n';

/** celld 0.6.3 `PIDS_LIMIT`. */
export const CELLD_PIDS_LIMIT = 1024;

const GIB = 1024 * 1024 * 1024;

/** celld 0.6.3 `instance_resources`: vCPU and memory per instance type. */
const INSTANCE_RESOURCES: Readonly<Record<string, { vcpu: number; memory: number }>> = {
  lite: { vcpu: 1 / 16, memory: 256 * 1024 * 1024 },
  basic: { vcpu: 0.25, memory: GIB },
  'standard-1': { vcpu: 0.5, memory: 4 * GIB },
  'standard-2': { vcpu: 1, memory: 6 * GIB },
  'standard-3': { vcpu: 2, memory: 8 * GIB },
  'standard-4': { vcpu: 4, memory: 12 * GIB },
};

export const DOCKER_PROXY_DIR = 'docker-proxy';

/** Runs the Docker CLI and returns trimmed stdout; throws on failure. */
export type DockerCli = (args: string[]) => string;

/** celld's image reference for an image id (`resolve_image`). */
export function celldImageReference(docker: DockerCli, imageId: string): string {
  const content = docker([
    'image',
    'inspect',
    '--format',
    '{{json .RootFS.Layers}}{{json .Config}}',
    imageId,
  ]);
  return `celld-image:${createHash('sha256').update(content).digest('hex')}`;
}

/** Build `dockerfile` (path) in `context` and return celld's reference for the result. */
export function buildImageReference(
  docker: DockerCli,
  dockerfile: string,
  context: string
): string {
  return celldImageReference(docker, docker(['build', '-q', '-f', dockerfile, context]));
}

/** Build celld's fence image exactly as `celld deploy` does and return its reference. */
export function buildFenceImageReference(docker: DockerCli): string {
  const context = mkdtempSync(join(tmpdir(), 'sam-celld-fence-'));
  try {
    writeFileSync(join(context, 'Dockerfile'), CELLD_FENCE_DOCKERFILE);
    return buildImageReference(docker, join(context, 'Dockerfile'), context);
  } finally {
    rmSync(context, { recursive: true, force: true });
  }
}

/** Whether the Docker daemon holds `reference` (celld tags every image it builds). */
export function imageTagged(docker: DockerCli, reference: string): boolean {
  try {
    docker(['image', 'inspect', '--format', '{{.Id}}', reference]);
    return true;
  } catch {
    return false;
  }
}

/**
 * The sandbox image the previous deploy allowed, if any: kept for one deploy so a node still on
 * the previous version (until celld swaps generations) can start its sandbox.
 *
 * With `docker`, an image the daemon does not hold is dropped. When a deploy's predicted image
 * and celld's own build disagree (the deploy then fails in assertCelldTaggedImages), the predicted
 * image was never tagged; carrying it forward would fail the next deploy too, although no node
 * can be running it.
 */
export function previousSandboxImages(stateDir: string, docker?: DockerCli): string[] {
  try {
    const previous = parsePolicy(
      readFileSync(join(stateDir, DOCKER_PROXY_DIR, 'policy.json'), 'utf8')
    );
    const kept = previous.sandboxImages.slice(0, 1);
    return docker ? kept.filter((reference) => imageTagged(docker, reference)) : kept;
  } catch {
    return [];
  }
}

export function renderProxyPolicy(input: {
  runtime: string;
  instanceType: string;
  sandboxImage: string;
  fenceImage: string;
  stateDir: string;
  previousSandboxImages?: string[];
}): ProxyPolicy {
  const resources = INSTANCE_RESOURCES[input.instanceType];
  if (!resources) throw new Error(`no resources known for instance type ${input.instanceType}`);
  const resolvConfHostPath = join(input.stateDir, DOCKER_PROXY_DIR, 'container-resolv.conf');
  if (!resolvConfHostPath.startsWith('/') || resolvConfHostPath.includes(':')) {
    throw new Error(`the state dir must be an absolute path without ":" (${input.stateDir})`);
  }
  return {
    runtime: input.runtime,
    sandboxImages: [
      input.sandboxImage,
      ...(input.previousSandboxImages ?? []).filter((ref) => ref !== input.sandboxImage),
    ],
    fenceImage: input.fenceImage,
    fenceRulesSha256: CELLD_FENCE_RULES_SHA256,
    celldResolvConfBind: CELLD_RESOLV_CONF_BIND,
    resolvConfHostPath,
    maxMemoryBytes: resources.memory,
    // celld sends (vcpu * 1e9) as u64.
    maxNanoCpus: Math.floor(resources.vcpu * 1e9),
    maxPidsLimit: CELLD_PIDS_LIMIT,
  };
}

function writeAtomically(path: string, content: string): void {
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, content, { mode: 0o644 });
  chmodSync(temporary, 0o644);
  // A rename inside the directory the proxy mounts: the proxy sees the new file on its next read.
  renameSync(temporary, path);
}

/**
 * `--init`: the directory compose binds into the proxy must exist, owned by the operator, before
 * `docker compose up` (Docker would create a missing one as root). The policy follows on deploy.
 */
export function ensureDockerProxyDir(stateDir: string): string {
  const dir = join(stateDir, DOCKER_PROXY_DIR);
  mkdirSync(dir, { recursive: true, mode: 0o755 });
  chmodSync(dir, 0o755);
  writeAtomically(join(dir, 'container-resolv.conf'), SANDBOX_RESOLV_CONF);
  return dir;
}

/**
 * Writes `<stateDir>/docker-proxy/{policy.json,container-resolv.conf}`. World-readable: the proxy
 * runs as its own uid, and neither file holds a secret. Returns the directory.
 */
export function writeDockerProxyFiles(stateDir: string, policy: ProxyPolicy): string {
  const dir = ensureDockerProxyDir(stateDir);
  writeAtomically(join(dir, 'policy.json'), `${JSON.stringify(policy, null, 2)}\n`);
  return dir;
}

/** After `celld deploy`: celld must have tagged exactly the references the policy allows. */
export function assertCelldTaggedImages(docker: DockerCli, policy: ProxyPolicy): void {
  for (const reference of [...policy.sandboxImages, policy.fenceImage]) {
    if (!imageTagged(docker, reference)) {
      throw new Error(
        `celld deploy did not tag ${reference}, which the Docker socket proxy policy allows: ` +
          'celld computed a different image reference (did the base image move between builds?). ' +
          'Run the deploy again; guided login refuses every container until the two agree.'
      );
    }
  }
}

/** The Docker CLI on the deploying machine (on a one-box install, the node itself). */
export const hostDocker: DockerCli = (args) => {
  const result = spawnSync('docker', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`docker ${args[0]} failed: ${(result.stderr ?? '').trim().slice(0, 500)}`);
  }
  return (result.stdout ?? '').trim();
};

/**
 * Before `celld deploy`: build the sandbox image (from the context celld will build, so celld's
 * build hits the cache) and the fence image, and write the policy that allows exactly those.
 */
export function prepareDockerProxyPolicy(input: {
  docker: DockerCli;
  stateDir: string;
  projectDir: string;
  settings: GuidedLoginSettings;
}): ProxyPolicy {
  const context = join(input.projectDir, SANDBOX_IMAGE_DIR);
  const policy = renderProxyPolicy({
    runtime: input.settings.runtime,
    instanceType: input.settings.instanceType,
    sandboxImage: buildImageReference(input.docker, join(context, 'Dockerfile'), context),
    fenceImage: buildFenceImageReference(input.docker),
    stateDir: input.stateDir,
    previousSandboxImages: previousSandboxImages(input.stateDir, input.docker),
  });
  writeDockerProxyFiles(input.stateDir, policy);
  return policy;
}
