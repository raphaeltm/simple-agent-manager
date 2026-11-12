/**
 * Guided credential login on a self-hosted box (opt-in, `SAM_GUIDED_LOGIN=on` in `.env`).
 *
 * The "sign in with your Claude / ChatGPT subscription" flow runs the provider CLI in a Sandbox
 * SDK container (`SandboxDO`, apps/api/Dockerfile.sandbox) that a Durable Object drives inbound
 * only: the container never calls SAM. celld's experimental container support runs
 * `@cloudflare/sandbox` as published, so the box can serve this class while Instant stays off
 * (Instant's vm-agent must call the API on the same box, which celld's container fence refuses).
 *
 * This module holds the pieces the deploy needs: the settings, the class it applies to, and the
 * minimal image build context. celld builds an image from the Dockerfile's own directory, so the
 * context is materialised inside the project dir with only the files the Dockerfile copies.
 */
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';

/** The one container class a box runs. VmAgentContainer (Instant) is never emitted. */
export const GUIDED_LOGIN_CONTAINER_CLASS = 'SandboxDO';

/** Image build context inside the project dir (celld uses the Dockerfile's directory). */
export const SANDBOX_IMAGE_DIR = 'containers/sandbox';

/** Host interface of celld's Internet-enabled container bridge (celld 0.6.3 `OPEN_BRIDGE`). */
export const CELLD_CONTAINER_BRIDGE = 'celld0';

/** gVisor: the sandbox runs a vendor CLI and handles a fresh credential on the control-plane box. */
export const DEFAULT_GUIDED_LOGIN_RUNTIME = 'runsc';

/**
 * Cloudflare's `basic` type (1/4 vCPU, 1 GiB). `standard-1` would commit 4 GiB of box memory per
 * concurrent setup session; the two CLIs fit in `basic` (measured on the prototype box).
 */
export const DEFAULT_GUIDED_LOGIN_INSTANCE_TYPE = 'basic';

const INSTANCE_TYPES = new Set([
  'lite',
  'basic',
  'standard-1',
  'standard-2',
  'standard-3',
  'standard-4',
]);

export interface GuidedLoginSettings {
  /**
   * OCI runtime celld starts the container under. Always named: the Docker socket proxy refuses
   * any sandbox that does not name exactly this runtime (`docker-proxy/policy.ts`).
   */
  runtime: string;
  instanceType: string;
}

function flag(raw: string | undefined, name: string): boolean {
  const value = (raw ?? '').trim().toLowerCase();
  if (value === '' || value === 'off' || value === 'false' || value === '0') return false;
  if (value === 'on' || value === 'true' || value === '1') return true;
  throw new Error(`${name} must be on or off`);
}

/** Null when guided login is off (the default). Throws on a malformed setting. */
export function guidedLoginSettings(
  box: Readonly<Record<string, string>>
): GuidedLoginSettings | null {
  if (!flag(box.SAM_GUIDED_LOGIN, 'SAM_GUIDED_LOGIN')) return null;
  const runtime = (box.SAM_GUIDED_LOGIN_RUNTIME ?? '').trim() || DEFAULT_GUIDED_LOGIN_RUNTIME;
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(runtime)) {
    throw new Error(`SAM_GUIDED_LOGIN_RUNTIME "${runtime}" is not an OCI runtime name`);
  }
  const instanceType =
    (box.SAM_GUIDED_LOGIN_INSTANCE_TYPE ?? '').trim() || DEFAULT_GUIDED_LOGIN_INSTANCE_TYPE;
  if (!INSTANCE_TYPES.has(instanceType)) {
    throw new Error(
      `SAM_GUIDED_LOGIN_INSTANCE_TYPE "${instanceType}" is not a celld instance type`
    );
  }
  // `runc` shares the host kernel with the encryption key and the database; it must be asked for
  // by name. "default" (whatever the daemon defaults to) cannot be pinned by the socket proxy.
  if (runtime === 'default') {
    throw new Error(
      'SAM_GUIDED_LOGIN_RUNTIME=default is not supported: name the runtime (runsc, or runc to ' +
        'accept a shared host kernel)'
    );
  }
  return { runtime, instanceType };
}

/** Sources of every `COPY <src> <dest>` line, relative to the Dockerfile's directory. */
export function dockerfileCopySources(dockerfile: string): string[] {
  const sources: string[] = [];
  for (const line of dockerfile.split('\n')) {
    const args = /^\s*COPY\s+(.+)$/i.exec(line)?.[1]?.trim();
    if (args === undefined) continue;
    if (args.endsWith('\\')) {
      throw new Error(`Dockerfile COPY continuation lines are not supported: ${line.trim()}`);
    }
    const parts = args.split(/\s+/);
    if (parts.some((part) => part.startsWith('--') || part.startsWith('['))) {
      throw new Error(`Dockerfile COPY form not supported here: ${line.trim()}`);
    }
    for (const source of parts.slice(0, -1)) {
      const clean = normalize(source);
      if (clean.startsWith('..') || clean.startsWith('/') || /[*?]/.test(clean)) {
        throw new Error(`Dockerfile COPY source must be a plain relative file: ${source}`);
      }
      sources.push(clean);
    }
  }
  return sources;
}

/**
 * Writes `<projectDir>/containers/sandbox/` with the Dockerfile and only the files it copies, so
 * the build context sent to Docker is a few KB rather than apps/api (and never `.dev.vars`).
 */
export function materialiseSandboxImageContext(
  apiDir: string,
  projectDir: string,
  dockerfileName = 'Dockerfile.sandbox'
): string {
  const dockerfilePath = join(apiDir, dockerfileName);
  const dockerfile = readFileSync(dockerfilePath, 'utf8');
  const target = join(projectDir, SANDBOX_IMAGE_DIR);
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  copyFileSync(dockerfilePath, join(target, 'Dockerfile'));
  for (const source of dockerfileCopySources(dockerfile)) {
    const from = join(apiDir, source);
    if (!existsSync(from)) throw new Error(`${dockerfileName} copies ${source}, which is missing`);
    // A symlink could pull any file on the box into an image stored in the fleet bucket.
    if (!lstatSync(from).isFile()) {
      throw new Error(`${dockerfileName} copies ${source}, which is not a regular file`);
    }
    mkdirSync(dirname(join(target, source)), { recursive: true });
    copyFileSync(from, join(target, source));
  }
  return `${SANDBOX_IMAGE_DIR}/Dockerfile`;
}

/** What `docker info --format '{{json .Runtimes}}'` answered, or why it could not. */
export type EngineProbe = { ok: true; runtimesJson: string } | { ok: false; error: string };

/**
 * Refuses a deploy that would advertise guided login with nothing able to run it. Without a
 * daemon, or with the runtime unregistered, every session fails only after the Sandbox SDK's
 * ~150 s start-retry window, and its teardown waits through a second one (measured on the
 * prototype box, celld 0.6.3: `unknown or invalid runtime name: runsc`). Checked on the deploying
 * machine, which on a one-box install is the node; a node whose engine changes later is not
 * covered.
 */
export function assertContainerEngineReady(
  settings: GuidedLoginSettings,
  probe: EngineProbe
): void {
  if (!probe.ok) {
    throw new Error(
      `SAM_GUIDED_LOGIN=on needs a Docker daemon on this box (docker info failed: ${probe.error})`
    );
  }
  let runtimes: unknown;
  try {
    runtimes = JSON.parse(probe.runtimesJson);
  } catch {
    throw new Error(
      `could not read the Docker daemon's runtimes: ${probe.runtimesJson.slice(0, 200)}`
    );
  }
  if (typeof runtimes !== 'object' || runtimes === null || !Object.hasOwn(runtimes, settings.runtime)) {
    throw new Error(
      `SAM_GUIDED_LOGIN_RUNTIME=${settings.runtime} is not registered with the Docker daemon ` +
        `(for gVisor: install runsc, run \`sudo runsc install\`, restart Docker)`
    );
  }
}
