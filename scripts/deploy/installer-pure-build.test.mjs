import test from 'node:test';
import assert from 'node:assert/strict';
import {
  readFileSync,
  readdirSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import { resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '../..');
// Normalize command arrays as well as shell commands. Emitting tsc is an artifact
// build; tsc --noEmit and named validation tasks are standalone checks.
function assertPure(source, label) {
  const commands = source.replace(/['"`,()\[\]]/g, ' ');
  assert.doesNotMatch(
    commands,
    /\b(?:vitest|jest|mocha|ava|eslint(?!-disable)|oxlint|golangci-lint)\b|\b(?:go|cargo(?:\s+\+[^\s]+)?)\s+test\b|\bnode\s+--test\b|\b(?:pnpm|npm|yarn|bun)(?:\s+(?:(?:--(?:filter|dir|prefix|workspace)|-[FC])\s+[^\s;&]+|--[\w=@/.*!:-]+|-[rw]))*(?:\s+(?:run|exec))?\s+(?:test(?:[\w:-]*)|lint(?:[\w:-]*)|typecheck)\b|\btsc\b[^\n;&]*--noEmit|\bastro\s+check\b/i,
    label
  );
}

function auditBuildGraph(
  base,
  entries = [
    'scripts/deploy/installer-builder-bootstrap.sh',
    'scripts/deploy/installer-builder-bootstrap-fit.sh',
    // Wrangler builds these fixed runtime images during the engine deploy path.
    'apps/api/Dockerfile.sandbox',
    'apps/api/Dockerfile.vm-agent-container',
  ]
) {
  const seen = new Set();
  function visit(file) {
    file = resolve(file);
    if (seen.has(file) || !existsSync(file)) return;
    seen.add(file);
    const source = readFileSync(file, 'utf8')
      .replace(/^\s*(?:#|\/\/).*$/gm, '')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    assertPure(source, file);
    // Follow literal repo scripts, local imports, and the engine's script(name)
    // adapter. This includes callers added in future without extending a list.
    for (const match of source.matchAll(
      /(?:scripts\/[\w./-]+\.(?:sh|mjs|ts)|(?:\.\.\/|\.\/)[\w./-]+\.(?:sh|mjs|ts))/g
    )) {
      visit(resolve(match[0].startsWith('scripts/') ? base : dirname(file), match[0]));
    }
    for (const match of source.matchAll(/\b[\w./-]*Dockerfile(?:[\w.-]*)/g)) {
      visit(resolve(base, match[0]));
    }
    if (/Dockerfile[^/]*$/.test(file)) {
      // COPY paths are relative to Docker's build context (apps/api for these
      // images). Only follow executable installers used by RUN, never arbitrary
      // copied runtime sources or binaries, and skip copies from another stage.
      const instructions = source.replace(/\\\n/g, ' ');
      const runs = [...instructions.matchAll(/^RUN\s+(.+)$/gm)].map((match) => match[1]).join('\n');
      for (const match of instructions.matchAll(/^COPY\s+(?!.*--from=)([^\n]+)$/gm)) {
        const fields = match[1]
          .replace(/["\[\],]/g, '')
          .trim()
          .split(/\s+/);
        const destination = fields.pop();
        if (!destination || !runs.includes(destination)) continue;
        for (const input of fields) {
          if (/\.(?:sh|mjs|js|cjs|py)$/.test(input)) visit(resolve(dirname(file), input));
        }
      }
    }
    for (const match of source.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
      const imported = resolve(dirname(file), match[1]);
      visit(existsSync(imported) ? imported : `${imported.replace(/\.js$/, '')}.ts`);
    }
    for (const match of source.matchAll(/\bscript\(['"]([\w.-]+)['"]/g))
      visit(resolve(base, 'scripts/deploy', match[1]));
  }
  for (const entry of entries) visit(resolve(base, entry));
  return seen;
}

test('in-account bootstrap and every reachable local script are pure builds', () => {
  const seen = auditBuildGraph(root);
  assert.ok(seen.has(resolve(root, 'scripts/diagnostics/build-pinned-codex-review.sh')));
  assert.ok(seen.has(resolve(root, 'scripts/deploy/installer-engine.ts')));
  assert.ok(seen.has(resolve(root, 'apps/api/Dockerfile.sandbox')));
  assert.ok(seen.has(resolve(root, 'apps/api/Dockerfile.vm-agent-container')));
  assert.ok(seen.has(resolve(root, 'apps/api/container-entrypoints/patch-acp-amp.py')));
});

test('workspace artifact build scripts and their lifecycle/nested scripts stay pure', () => {
  for (const directory of [
    '.',
    ...['apps', 'packages'].flatMap((parent) =>
      readdirSync(resolve(root, parent)).map((name) => `${parent}/${name}`)
    ),
  ]) {
    const path = resolve(root, directory, 'package.json');
    if (!existsSync(path)) continue;
    const scripts = JSON.parse(readFileSync(path, 'utf8')).scripts ?? {};
    const visited = new Set();
    function visit(name) {
      if (visited.has(name) || !scripts[name]) return;
      visited.add(name);
      const body = scripts[name];
      assertPure(body, `${path}#${name}`);
      visit(`pre${name}`);
      visit(`post${name}`);
      for (const match of body.matchAll(/\b(?:pnpm|npm|yarn|bun)(?:\s+run)?\s+([\w:-]+)/g))
        visit(match[1]);
      for (const match of body.matchAll(/\b([\w./-]+\.(?:mjs|ts|sh))\b/g)) {
        const file = resolve(root, directory, match[1]);
        if (existsSync(file)) auditBuildGraph(root, [file]);
      }
    }
    for (const name of ['build', 'preinstall', 'install', 'postinstall', 'prepare']) visit(name);
  }
  // Turbo must not introduce validation through task dependencies.
  const turbo = readFileSync(resolve(root, 'turbo.json'), 'utf8').replace(/^\s*\/\/.*$/gm, '');
  const tasks = JSON.parse(turbo).tasks;
  const seen = new Set();
  function visitTask(name) {
    if (seen.has(name)) return;
    seen.add(name);
    assert.doesNotMatch(name, /test|lint|typecheck/);
    for (const dependency of tasks[name]?.dependsOn ?? []) visitTask(dependency.replace(/^\^/, ''));
  }
  visitTask('build');
});

test('selected Go make targets contain no validation, including prerequisites', () => {
  for (const [directory, targets] of [
    ['packages/cli', ['build-all', 'version']],
    ['packages/vm-agent', ['prepare-container', 'build-all']],
  ]) {
    const commands = execFileSync(
      'make',
      ['-n', '-C', resolve(root, directory), '-o', 'prepare-codex-runtime', ...targets],
      { encoding: 'utf8' }
    );
    assertPure(commands.replace(/\$\(GO\)/g, 'go'), directory);
  }
});

test('guard catches forbidden runners in shell commands and engine command arrays', () => {
  for (const command of [
    'vitest run',
    'npx jest',
    'go test ./...',
    'cargo +1.95.0 test',
    'pnpm test:unit',
    'pnpm --filter @simple-agent-manager/api test',
    'pnpm --filter=@simple-agent-manager/api run test:unit',
    'pnpm -F @simple-agent-manager/api test',
    "execute('pnpm', ['--filter', '@simple-agent-manager/api', 'test'])",
    "pnpm('test')",
    "pnpm('--filter', '@simple-agent-manager/api', 'test')",
    "pnpm('--filter', '@simple-agent-manager/api', 'run', 'typecheck')",
    'npm run lint',
    'pnpm typecheck',
    "execute('pnpm', ['exec', 'vitest', 'run'])",
    'node --test',
    'tsc --noEmit',
  ]) {
    assert.throws(() => assertPure(command, command));
  }
  assert.doesNotThrow(() =>
    assertPure(
      "tsc && cargo build && go build && npm --ignore-scripts run build && pnpm --filter @simple-agent-manager/api build && pnpm('--filter', '@simple-agent-manager/api', 'build')",
      'artifact builds'
    )
  );
});

test('guard follows Dockerfiles and rejects validation in RUN or a copied build installer', () => {
  const fixture = mkdtempSync(resolve(tmpdir(), 'sam-pure-image-'));
  try {
    mkdirSync(resolve(fixture, 'apps/api'), { recursive: true });
    const dockerfile = resolve(fixture, 'apps/api/Dockerfile.fixture');
    writeFileSync(
      resolve(fixture, 'build.sh'),
      'docker build -f apps/api/Dockerfile.fixture apps/api\n'
    );
    writeFileSync(dockerfile, 'FROM scratch\nRUN pnpm test\n');
    assert.throws(() => auditBuildGraph(fixture, ['build.sh']), /Dockerfile.fixture/);
    writeFileSync(
      dockerfile,
      'FROM scratch\nCOPY install.sh /tmp/install.sh\nRUN bash /tmp/install.sh\n'
    );
    writeFileSync(resolve(fixture, 'apps/api/install.sh'), 'cargo test\n');
    assert.throws(() => auditBuildGraph(fixture, ['build.sh']), /install.sh/);
    writeFileSync(resolve(fixture, 'apps/api/install.sh'), 'cargo build\n');
    // Runtime-only sources can contain user workloads; copying is not execution.
    writeFileSync(resolve(fixture, 'apps/api/user-script.sh'), 'pnpm test\n');
    writeFileSync(
      dockerfile,
      readFileSync(dockerfile, 'utf8') + 'COPY user-script.sh /runtime/user-script.sh\n'
    );
    assert.doesNotThrow(() => auditBuildGraph(fixture, ['build.sh']));
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
