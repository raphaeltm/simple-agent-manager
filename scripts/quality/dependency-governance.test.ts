import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, posix, relative } from 'node:path';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

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

/** Strips the `docker.io/` registry prefix and any `@sha256:...` digest suffix. */
function normaliseImageRef(ref: string): string {
  return ref.replace(/^docker\.io\//, '').split('@')[0]!;
}

interface ReviewedSourcePair {
  /** Normalised `image:tag` from the nearest preceding reviewed-source-tag comment. */
  declared: string | undefined;
  /** Normalised `image:tag` from the `FROM` line that comment governs. */
  from: string;
  line: number;
}

/**
 * Pairs every `FROM` with the reviewed-source-tag comment that immediately
 * precedes it. Two comment shapes exist in this repo:
 *   `# Reviewed source tag: docker.io/library/node:26-bookworm-slim`
 *   `# IMPORTANT: The reviewed source tag for this digest is cloudflare/sandbox:0.12.5 and MUST ...`
 *
 * Pairing by nearest-preceding comment (rather than searching the whole file for
 * one comment) is what makes this correct for multi-stage builds: each
 * `FROM ... AS stage` gets its own declaration, and a stale comment on stage 2
 * cannot be masked by stage 1 still matching. Only real `#` comment lines are
 * considered, and a pending declaration is consumed by the first `FROM` after
 * it, so prose that merely mentions the phrase cannot bind to a distant `FROM`.
 *
 * Operates on text, not paths, so it covers Dockerfiles embedded in workflow
 * heredocs as well as standalone Dockerfiles.
 */
function reviewedSourcePairs(contents: string): ReviewedSourcePair[] {
  const declarationPattern = /reviewed source tag(?:\s+for this digest)?\s*(?::|is)\s*(\S+)/i;
  const pairs: ReviewedSourcePair[] = [];
  let pending: string | undefined;

  contents.split('\n').forEach((rawLine, index) => {
    const line = rawLine.trim();

    if (line.startsWith('#')) {
      const match = declarationPattern.exec(line);
      if (match) {
        // Two declarations before a single FROM means one of them governs
        // nothing and would be silently dropped by the overwrite — a false pass
        // in exactly the file whose job is to prevent false passes. Surface it
        // as an unpaired declaration instead, so it fails loudly.
        if (pending !== undefined) {
          pairs.push({ declared: pending, from: '<no FROM follows this declaration>', line: index });
        }
        pending = normaliseImageRef(match[1]!);
      }
      return;
    }

    if (/^FROM\s+\S+/i.test(line)) {
      pairs.push({
        declared: pending,
        from: normaliseImageRef(line.split(/\s+/)[1]!),
        line: index + 1,
      });
      pending = undefined;
    }
  });

  return pairs;
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
  // Covers workflow-embedded heredoc Dockerfiles too (e.g.
  // .github/workflows/devcontainer-cache-experiments.yml), which use the same
  // convention but are not files named `Dockerfile*`, so a path-based walk alone
  // would miss them.
  it('keeps each Dockerfile reviewed-source-tag comment in sync with its FROM tag', () => {
    const sources = [
      ...walk('.', (path) => /(^|\/)Dockerfile(\.|$)/.test(path)),
      ...walk('.github/workflows', (path) => path.endsWith('.yml') || path.endsWith('.yaml')),
    ];
    expect(sources.length).toBeGreaterThan(0);

    const checked: string[] = [];
    for (const file of sources) {
      for (const pair of reviewedSourcePairs(read(file))) {
        // Workflow files legitimately contain `FROM` lines with no reviewed-tag
        // convention; only Dockerfiles are required to declare one. Inside a
        // workflow, assert only on stanzas that opted into the convention.
        const isDockerfile = /(^|\/)Dockerfile(\.|$)/.test(file);
        if (!isDockerfile && pair.declared === undefined) continue;

        expect(
          pair.declared,
          `${file}:${pair.line} — every FROM in a Dockerfile must be preceded by a reviewed source tag comment`
        ).toBeDefined();
        expect(
          pair.from,
          `${file}:${pair.line} — reviewed source tag "${pair.declared}" does not match its FROM tag`
        ).toBe(pair.declared);
        checked.push(`${file}:${pair.line}`);
      }
    }

    // Guards the guard: if `walk()` or the parser silently stops finding
    // stanzas, this test would vacuously pass. The three Dockerfiles plus the
    // two workflow heredocs are the known floor.
    expect(checked.length).toBeGreaterThanOrEqual(5);
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

    // Split from the format assertion below so a prerelease tag reports "not a
    // plain x.y.z version" rather than being misreported as a missing FROM line.
    expect(
      imageTag,
      'apps/api/Dockerfile.sandbox must FROM cloudflare/sandbox:<tag>'
    ).toBeDefined();
    expect(
      imageTag,
      `Dockerfile.sandbox image tag "${imageTag}" is not a plain x.y.z version. Prereleases are rejected deliberately: they need a human to confirm the npm client ships the same prerelease before this pin is trusted.`
    ).toMatch(/^\d+\.\d+\.\d+$/);

    // Every declaration, not just apps/api's. A second workspace declaring
    // @cloudflare/sandbox (e.g. apps/web for the /xterm client) with a caret
    // range would reintroduce exactly the drift this test exists to prevent.
    const manifests = walk(
      '.',
      (path) => path.endsWith('package.json') && !path.includes('node_modules')
    );
    const declarations = manifests.flatMap((file) => {
      const pkg = JSON.parse(read(file)) as Record<string, Record<string, string> | undefined>;
      return (['dependencies', 'devDependencies', 'optionalDependencies'] as const)
        .map((field) => pkg[field]?.['@cloudflare/sandbox'])
        .filter((version): version is string => typeof version === 'string')
        .map((version) => ({ file, version }));
    });

    expect(
      declarations.length,
      'expected at least one @cloudflare/sandbox declaration; did the walk stop finding manifests?'
    ).toBeGreaterThan(0);

    for (const { file, version } of declarations) {
      // An exact pin (no ^ or ~) is required: a range lets the npm client drift
      // away from the digest-pinned image on any unrelated `pnpm install`.
      expect(
        version,
        `${file}: @cloudflare/sandbox must be an exact version pin, not a semver range (found "${version}")`
      ).toMatch(/^\d+\.\d+\.\d+$/);
      expect(
        version,
        `${file}: @cloudflare/sandbox npm version must equal the Dockerfile.sandbox image tag ${imageTag}`
      ).toBe(imageTag);
    }
  });

  // Dependabot bumps ONE manifest entry at a time and its `groups:` config cannot
  // express "these siblings ship from one repo". So a lockstep-released group
  // routinely arrives with only one member moved. Every group below has actually
  // drifted or been caught mid-drift in this repo:
  //   - react/react-dom: #1856 grouped `react` with `@types/react` but NOT
  //     `react-dom`, which ships from the same repo and loads the matching
  //     reconciler build. Merging it as authored would have landed react 19.2.8
  //     against react-dom 19.2.7.
  //   - @commitlint/cli + config-conventional: #1854 moved only the config.
  //   - typescript-eslint trio: pnpm-workspace.yaml already carried a comment
  //     saying "Dependabot only proposes the parser" — prose, enforced nowhere.
  //   - vitest + @vitest/coverage-v8: coverage-v8 declares an EXACT peer pin on
  //     vitest, and the catalog was violating it (4.1.5 vs 4.1.7) until this batch.
  // Both halves were caught by a human every time. This test is what makes that
  // repeatable. Adding a newly discovered pair should be a one-line change here.
  it('keeps lockstep-released package groups on identical versions', () => {
    const catalog = (parse(read('pnpm-workspace.yaml')) as { catalog: Record<string, string> })
      .catalog;
    const rootDevDeps = (
      JSON.parse(read('package.json')) as { devDependencies: Record<string, string> }
    ).devDependencies;

    const groups = [
      {
        label: 'react ecosystem (react and react-dom ship from one repo)',
        source: 'pnpm-workspace.yaml catalog',
        members: ['react', 'react-dom'] as const,
        lookup: (name: string) => catalog[name],
      },
      {
        label: 'typescript-eslint (released in lockstep from one monorepo)',
        source: 'pnpm-workspace.yaml catalog',
        members: [
          '@typescript-eslint/eslint-plugin',
          '@typescript-eslint/parser',
          'typescript-eslint',
        ] as const,
        lookup: (name: string) => catalog[name],
      },
      {
        label: 'vitest (@vitest/coverage-v8 declares an exact peer pin on vitest)',
        source: 'pnpm-workspace.yaml catalog',
        members: ['vitest', '@vitest/coverage-v8'] as const,
        lookup: (name: string) => catalog[name],
      },
      {
        label: 'commitlint (cli and config-conventional are released together)',
        source: 'package.json devDependencies',
        members: ['@commitlint/cli', '@commitlint/config-conventional'] as const,
        lookup: (name: string) => rootDevDeps[name],
      },
    ];

    // Guards the guard: a renamed catalog key or a restructured manifest would
    // otherwise make every group resolve to `undefined` and pass vacuously.
    expect(groups.length).toBeGreaterThanOrEqual(4);

    for (const { label, source, members, lookup } of groups) {
      const resolved = members.map((name) => ({ name, version: lookup(name) }));

      for (const { name, version } of resolved) {
        expect(
          version,
          `${label}: "${name}" was not found in ${source}. If it moved, update this group rather than deleting it.`
        ).toBeDefined();
      }

      const distinct = new Set(resolved.map(({ version }) => version));
      expect(
        distinct.size,
        `${label}: all members must be on one version, found ${resolved
          .map(({ name, version }) => `${name}@${version}`)
          .join(', ')}`
      ).toBe(1);
    }
  });
});
