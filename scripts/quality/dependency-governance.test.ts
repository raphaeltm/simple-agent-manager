import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, posix, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..', '..');

function read(path: string): string {
  return readFileSync(join(root, path), 'utf8');
}

function walk(dir: string, predicate: (path: string) => boolean): string[] {
  const absoluteDir = join(root, dir);
  if (!existsSync(absoluteDir)) return [];

  const paths: string[] = [];
  for (const entry of readdirSync(absoluteDir)) {
    if (entry === 'node_modules' || entry === '.git') continue;
    const absolutePath = join(absoluteDir, entry);
    const repoPath = posix.normalize(relative(root, absolutePath).replaceAll('\\', '/'));
    const stats = statSync(absolutePath);
    if (stats.isDirectory()) {
      paths.push(...walk(repoPath, predicate));
    } else if (predicate(repoPath)) {
      paths.push(repoPath);
    }
  }
  return paths.sort();
}

function extractDependabotDirectories(ecosystem: string): Set<string> {
  const dependabot = read('.github/dependabot.yml');
  const directories = new Set<string>();
  const updateBlocks = dependabot.split(/\n\s*-\s+package-ecosystem:\s*/).slice(1);

  for (const block of updateBlocks) {
    const ecosystemMatch = /^["']?([^"'\n]+)["']?/.exec(block.trimStart());
    if (ecosystemMatch?.[1] !== ecosystem) continue;

    const directoryMatch = /\n\s+directory:\s+["']?([^"'\n]+)["']?/.exec(`\n${block}`);
    if (directoryMatch) directories.add(directoryMatch[1]);
  }

  return directories;
}

function npmGlobalInstallSpecs(files: string[], packageName: string): string[] {
  const specs: string[] = [];
  const escapedPackageName = packageName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const installPattern = new RegExp(
    `npm\\s+install(?:\\s+-{1,2}[^\\s"\']+)*\\s+["\']?(${escapedPackageName}(?:@[^\\s"\']+)?)`,
    'g'
  );

  for (const file of files) {
    const contents = read(file);
    for (const match of contents.matchAll(installPattern)) {
      specs.push(match[1]!);
    }
  }

  return specs;
}

/**
 * Extracts the human-declared "reviewed source tag" comment from a Dockerfile.
 * Two comment shapes exist in this repo:
 *   `# Reviewed source tag: docker.io/library/node:26-bookworm-slim`
 *   `# IMPORTANT: The reviewed source tag for this digest is cloudflare/sandbox:0.12.5 and MUST ...`
 * Returns the bare `image:tag` with any `docker.io/` registry prefix stripped,
 * so it is directly comparable to a normalised `FROM` ref.
 */
function reviewedSourceTag(file: string): string | undefined {
  const match = /reviewed source tag(?:\s+for this digest)?\s*(?::|is)\s*(\S+)/i.exec(read(file));
  return match ? normaliseImageRef(match[1]!) : undefined;
}

/** Strips the `docker.io/` registry prefix and any `@sha256:...` digest suffix. */
function normaliseImageRef(ref: string): string {
  return ref.replace(/^docker\.io\//, '').split('@')[0]!;
}

function dockerFromRefs(files: string[]): string[] {
  return files.flatMap((file) =>
    read(file)
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('FROM '))
      .map((line) => line.split(/\s+/)[1]!)
  );
}

function dockerRefsInTextFiles(files: string[]): string[] {
  return files.flatMap((file) =>
    read(file)
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /^FROM\s+\S+/.test(line))
      .map((line) => line.replace(/^FROM\s+/, '').split(/\s+/)[0]!)
  );
}

describe('dependency governance', () => {
  it('covers every Go module with Dependabot gomod updates', () => {
    const goModDirectories = walk('.', (path) => path.endsWith('/go.mod')).map(
      (path) => `/${posix.dirname(path)}`
    );
    const coveredDirectories = extractDependabotDirectories('gomod');

    expect([...coveredDirectories].sort()).toEqual(goModDirectories);
  });

  it('pins devcontainers CLI workflow installs to a reviewed version variable', () => {
    const workflowFiles = walk(
      '.github/workflows',
      (path) => path.endsWith('.yml') || path.endsWith('.yaml')
    );
    const installSpecs = npmGlobalInstallSpecs(workflowFiles, '@devcontainers/cli');

    expect(installSpecs.length).toBeGreaterThan(0);
    expect(
      installSpecs.every((spec) => spec === '@devcontainers/cli@${DEVCONTAINERS_CLI_VERSION}')
    ).toBe(true);

    const workflowContents = workflowFiles.map(read).join('\n');
    expect(workflowContents).toMatch(
      /npm install -g --ignore-scripts "@devcontainers\/cli@\$\{DEVCONTAINERS_CLI_VERSION\}"/
    );
    expect(workflowContents).toMatch(/DEVCONTAINERS_CLI_VERSION:\s+\d+\.\d+\.\d+/);
  });

  it('pins Playwright package downloads used outside the project lockfile', () => {
    const postCreate = read('.devcontainer/post-create.sh');
    const deployStaging = read('.github/workflows/deploy-staging.yml');

    expect(postCreate).not.toContain('@playwright/mcp@latest');
    expect(postCreate).toMatch(/SAM_PLAYWRIGHT_MCP_VERSION:=\d+\.\d+\.\d+/);
    expect(postCreate).toMatch(/@playwright\/mcp@\$\{SAM_PLAYWRIGHT_MCP_VERSION\}/);

    expect(deployStaging).toMatch(/PLAYWRIGHT_VERSION:\s+\d+\.\d+\.\d+/);
    expect(deployStaging).toMatch(
      /npm install --ignore-scripts "@playwright\/test@\$\{PLAYWRIGHT_VERSION\}"/
    );
  });

  it('prevents Docker base-image drift with digest pins and updater coverage', () => {
    const dockerfiles = walk('.', (path) => /(^|\/)Dockerfile(\.|$)/.test(path));
    const workflowFiles = walk(
      '.github/workflows',
      (path) => path.endsWith('.yml') || path.endsWith('.yaml')
    );
    const refs = [...dockerFromRefs(dockerfiles), ...dockerRefsInTextFiles(workflowFiles)];

    expect(dockerfiles).toEqual([
      'apps/api/Dockerfile.sandbox',
      'apps/api/Dockerfile.vm-agent-container',
      'scripts/e2e/workspace-mock/Dockerfile',
    ]);
    expect(refs.length).toBeGreaterThanOrEqual(dockerfiles.length);
    expect(refs.every((ref) => /@sha256:[a-f0-9]{64}$/.test(ref))).toBe(true);
    expect([...extractDependabotDirectories('docker')].sort()).toEqual([
      '/apps/api',
      '/scripts/e2e/workspace-mock',
    ]);
  });

  // Dependabot rewrites only the `FROM` line's digest. It never touches the
  // human-readable "reviewed source tag" comment that records which tag a human
  // actually reviewed, so a bumped image silently keeps a comment naming the
  // OLD version. Both #1790 (node 22 -> 26) and #1792 (sandbox 0.12.1 -> 0.12.5)
  // shipped that drift, and the digest-pin assertion above passes right through it.
  it('keeps each Dockerfile reviewed-source-tag comment in sync with its FROM tag', () => {
    const dockerfiles = walk('.', (path) => /(^|\/)Dockerfile(\.|$)/.test(path));
    expect(dockerfiles.length).toBeGreaterThan(0);

    for (const file of dockerfiles) {
      const declared = reviewedSourceTag(file);
      expect(declared, `${file} must declare a reviewed source tag comment`).toBeDefined();

      const fromRefs = dockerFromRefs([file]).map(normaliseImageRef);
      expect(
        fromRefs,
        `${file}: reviewed source tag "${declared}" does not match its FROM tag`
      ).toContain(declared);
    }
  });

  // The sandbox container server binary and the @cloudflare/sandbox npm client
  // speak the same versioned HTTP API, so a drift between them is a runtime
  // protocol mismatch that no type check or unit test can see. Dependabot bumps
  // the image and the npm package as two INDEPENDENT PRs, so this invariant has
  // to be asserted rather than assumed.
  it('pins @cloudflare/sandbox to exactly the cloudflare/sandbox image tag', () => {
    const imageTag = dockerFromRefs(['apps/api/Dockerfile.sandbox'])
      .map(normaliseImageRef)
      .find((ref) => ref.startsWith('cloudflare/sandbox:'))
      ?.split(':')[1];
    expect(imageTag, 'apps/api/Dockerfile.sandbox must FROM cloudflare/sandbox:<tag>').toMatch(
      /^\d+\.\d+\.\d+$/
    );

    const declared = (
      JSON.parse(read('apps/api/package.json')) as { dependencies: Record<string, string> }
    ).dependencies['@cloudflare/sandbox'];

    // An exact pin (no ^ or ~) is required: a range lets the npm client drift
    // away from the digest-pinned image on any unrelated `pnpm install`.
    expect(
      declared,
      '@cloudflare/sandbox must be an exact version pin, not a semver range'
    ).toMatch(/^\d+\.\d+\.\d+$/);
    expect(
      declared,
      `@cloudflare/sandbox npm version must equal the Dockerfile.sandbox image tag ${imageTag}`
    ).toBe(imageTag);
  });
});
