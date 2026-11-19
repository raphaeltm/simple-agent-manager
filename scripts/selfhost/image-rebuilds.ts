/**
 * Which locally built images a self-host upgrade must rebuild (F11). `selfhost:upgrade` used to
 * run `docker compose up -d --build` whenever any compose input changed; a build fetches base
 * images and modules from the network, so it now runs only for a service whose image would differ.
 */
import { isAbsolute, join, posix, relative } from 'node:path';

import { parse as parseYaml } from 'yaml';

import { isJsonRecord } from '../../packages/shared/src/runtime-validation.js';
import { REPO_ROOT, SELFHOST_DIR } from './deploy-steps.js';

/** The compose file, relative to the repository root (what `git show <ref>:<path>` reads). */
export const COMPOSE_PATH = relative(REPO_ROOT, join(SELFHOST_DIR, 'docker-compose.yml'));

type BuildSection = { context?: string; dockerfile?: string; args?: unknown };

interface ComposeBuildService {
  build?: string | BuildSection;
}

/** A compose file's text at the two refs an upgrade moves between (null: absent there). */
export interface ComposeOverlay {
  from: string | null;
  to: string | null;
}

/**
 * Build args as a mapping. Compose accepts a list (`- NAME=value`, or `- NAME` for a value taken
 * from the environment) or a mapping, and merges them by name across files whichever form each
 * file uses.
 */
function argsMap(args: unknown): Record<string, unknown> | undefined {
  if (Array.isArray(args)) {
    const map: Record<string, unknown> = {};
    for (const entry of args) {
      const text = String(entry);
      const separator = text.indexOf('=');
      if (separator < 0) map[text] = null;
      else map[text.slice(0, separator)] = text.slice(separator + 1);
    }
    return map;
  }
  return isJsonRecord(args) ? args : undefined;
}

function asSection(build: string | BuildSection): BuildSection {
  if (typeof build === 'string') return { context: build };
  const args = argsMap(build.args);
  return { ...build, ...(args === undefined ? {} : { args }) };
}

/**
 * Each locally built service's build section across the selected compose files, in order: a later
 * file's `build` keys replace the earlier file's, and its build args merge into theirs, as docker
 * compose merges them. A service no file builds is absent.
 */
function buildSections(composes: readonly (string | null)[]): Map<string, BuildSection> {
  const sections = new Map<string, BuildSection>();
  for (const compose of composes) {
    if (compose === null) continue;
    const parsed = parseYaml(compose) as { services?: Record<string, ComposeBuildService> } | null;
    for (const [name, service] of Object.entries(parsed?.services ?? {})) {
      if (service?.build === undefined) continue;
      const earlier = sections.get(name) ?? {};
      const later = asSection(service.build);
      const args =
        isJsonRecord(earlier.args) && isJsonRecord(later.args)
          ? { ...earlier.args, ...later.args }
          : (later.args ?? earlier.args);
      sections.set(name, { ...earlier, ...later, ...(args === undefined ? {} : { args }) });
    }
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
 * between the two refs and the box's compose files at each: docker-compose.yml, then every other
 * file its COMPOSE_FILE selects (`overlays`, in order), which may add or change a build section.
 * A service is rebuilt when its merged build section changed (context, Dockerfile, build args such
 * as the pinned Caddy module versions) or a file in its build context did. A context whose
 * .dockerignore is exactly `*` sends nothing to the build (caddy/), so only its Dockerfile and
 * .dockerignore count; README files never do. Docker compose resolves every file's relative paths
 * against the first file's directory, so a context is read relative to docker-compose.yml.
 *
 * Every other upgrade leaves the images alone (F11): a build fetches base images and modules from
 * the network, so it runs only when the image it would produce differs.
 */
export function imageRebuilds(
  changed: readonly string[],
  composeFrom: string | null,
  composeTo: string,
  readFileAtTo: (path: string) => string | null = () => null,
  overlays: readonly ComposeOverlay[] = []
): string[] {
  const before = buildSections([composeFrom, ...overlays.map((o) => o.from)]);
  const rebuilds: string[] = [];
  for (const [service, build] of buildSections([composeTo, ...overlays.map((o) => o.to)])) {
    if (JSON.stringify(before.get(service)) !== JSON.stringify(build)) {
      rebuilds.push(service);
      continue;
    }
    const contextRel = build.context ?? '.';
    const context = isAbsolute(contextRel)
      ? relative(REPO_ROOT, contextRel).split(/[\\/]/).join('/')
      : posix.join(posix.dirname(COMPOSE_PATH), contextRel);
    const dockerfile = posix.join(context, build.dockerfile ?? 'Dockerfile');
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
