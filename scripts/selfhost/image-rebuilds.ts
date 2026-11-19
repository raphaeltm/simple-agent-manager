/**
 * Which locally built images a self-host upgrade must rebuild (F11). `selfhost:upgrade` used to
 * run `docker compose up -d --build` whenever any compose input changed; a build fetches base
 * images and modules from the network, so it now runs only for a service whose image would differ.
 */
import { join, posix, relative } from 'node:path';

import { parse as parseYaml } from 'yaml';

import { REPO_ROOT, SELFHOST_DIR } from './deploy-steps.js';

/** The compose file, relative to the repository root (what `git show <ref>:<path>` reads). */
export const COMPOSE_PATH = relative(REPO_ROOT, join(SELFHOST_DIR, 'docker-compose.yml'));

interface ComposeBuildService {
  build?: string | { context?: string; dockerfile?: string; args?: unknown };
}

/** Each locally built service's build section, from a docker-compose.yml text (null: none). */
function buildSections(compose: string | null): Map<string, ComposeBuildService['build']> {
  const sections = new Map<string, ComposeBuildService['build']>();
  if (compose === null) return sections;
  const parsed = parseYaml(compose) as { services?: Record<string, ComposeBuildService> } | null;
  for (const [name, service] of Object.entries(parsed?.services ?? {})) {
    if (service?.build !== undefined) sections.set(name, service.build);
  }
  return sections;
}

/** Whether a .dockerignore sends nothing to the build: its only pattern is `*`. */
function ignoresEverything(dockerignore: string | null): boolean {
  const patterns = (dockerignore ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
  return patterns.length === 1 && patterns[0] === '*';
}

/**
 * The locally built services whose image this upgrade must rebuild, from the files that changed
 * between the two refs and docker-compose.yml at each: a service is rebuilt when its build section
 * changed (context, Dockerfile, build args such as the pinned Caddy module versions) or a file in
 * its build context did. A context whose .dockerignore is exactly `*` sends nothing to the build
 * (caddy/), so only its Dockerfile and .dockerignore count; README files never do.
 *
 * Every other upgrade leaves the images alone (F11): a build fetches base images and modules from
 * the network, so it runs only when the image it would produce differs.
 */
export function imageRebuilds(
  changed: readonly string[],
  composeFrom: string | null,
  composeTo: string,
  readFileAtTo: (path: string) => string | null = () => null
): string[] {
  const before = buildSections(composeFrom);
  const rebuilds: string[] = [];
  for (const [service, build] of buildSections(composeTo)) {
    if (JSON.stringify(before.get(service)) !== JSON.stringify(build)) {
      rebuilds.push(service);
      continue;
    }
    const contextRel = typeof build === 'string' ? build : (build?.context ?? '.');
    const context = posix.join(posix.dirname(COMPOSE_PATH), contextRel);
    const dockerfileName =
      (typeof build === 'object' ? build?.dockerfile : undefined) ?? 'Dockerfile';
    const dockerfile = posix.join(context, dockerfileName);
    const ignore = posix.join(context, '.dockerignore');
    const emptyContext = ignoresEverything(readFileAtTo(ignore));
    const touched = changed.some(
      (file) =>
        file === dockerfile ||
        file === ignore ||
        (!emptyContext && file.startsWith(`${context}/`) && !file.endsWith('.md'))
    );
    if (touched) rebuilds.push(service);
  }
  return rebuilds;
}
