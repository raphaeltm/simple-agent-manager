import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  cpSync,
  rmSync,
  chmodSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { packageRuntime, digest, publisher } from './build-installation-codex-package.mjs';
import { materializeTrust } from './build-installation-codex-trust.mjs';
const repo = resolve(new URL('../..', import.meta.url).pathname);
const paths = [
  'packages/vm-agent/internal/acp/codex_runtime_installer.sh',
  'packages/vm-agent/internal/acp/codex_runtime_distribution.go',
  'packages/vm-agent/internal/acp/codex_staging_candidate.go',
  'apps/api/src/routes/codex-runtime.ts',
  'scripts/deploy/prepare-codex-runtime-artifact.sh',
  'scripts/deploy/publish-codex-runtime-artifact.sh',
  'scripts/diagnostics/pinned-codex-local.provenance',
  'scripts/diagnostics/pinned-codex-bin',
];
function fixture() {
  const work = mkdtempSync(join(tmpdir(), 'sam-codex-package-test-'));
  const source = join(work, 'source'),
    review = join(work, 'review'),
    output = join(work, 'output');
  mkdirSync(review);
  mkdirSync(source);
  for (const path of paths) {
    mkdirSync(join(source, path, '..'), { recursive: true });
    cpSync(join(repo, path), join(source, path), { recursive: true });
  }
  const files = [
    'codex',
    'adapter.js',
    'codex-code-mode-host',
    'SOURCE-PROVENANCE',
    'BUILD-PROVENANCE',
    'CLI-Cargo.lock',
    'UPSTREAM-CLI-Cargo.lock',
    'ADAPTER-package-lock.json',
    'CLI-LICENSE',
    'ADAPTER-LICENSE',
    'codex-code-mode-host-x86_64-unknown-linux-musl.sigstore',
  ];
  for (const name of files) writeFileSync(join(review, name), name);
  writeFileSync(join(review, 'codex'), '#!/bin/sh\necho codex-cli 0.160.0-sam-c2.2\n');
  writeFileSync(
    join(review, 'adapter.js'),
    "console.log('@agentclientprotocol/codex-acp 2.1.1-sam-c2.2');\n"
  );
  let provenance = readFileSync(
    join(source, 'scripts/diagnostics/pinned-codex-local.provenance'),
    'utf8'
  );
  provenance = provenance.replace(
    '37cab1584302611e9936902219640ab5e7a79fcfccd2504c6e85ea8cb97d0e10',
    digest(readFileSync(join(review, 'codex-code-mode-host')))
  );
  provenance = provenance.replace(
    '2e8dee6465a7ac86a85a0c1735239ccb995a759e3a6fa8842ebd7d64318ba6ae',
    digest(readFileSync(join(review, files.at(-1))))
  );
  writeFileSync(join(source, 'scripts/diagnostics/pinned-codex-local.provenance'), provenance);
  writeFileSync(join(review, 'SOURCE-PROVENANCE'), provenance);
  writeFileSync(
    join(review, 'SHA256SUMS'),
    files.map((name) => `${digest(readFileSync(join(review, name)))}  ${name}\n`).join('')
  );
  return { work, source, review, output };
}
test('installation packaging compiles new trust anchors and installs verified runtime', () => {
  const f = fixture();
  try {
    const trust = packageRuntime(f.review, f.output, f.source);
    assert.notEqual(trust.archiveSHA256, publisher.archive);
    const second = join(f.work, 'second');
    packageRuntime(f.review, second, f.source);
    assert.equal(
      digest(readFileSync(join(second, 'codex-runtime-linux-amd64.tar.gz'))),
      trust.archiveSHA256
    );
    materializeTrust(f.output, f.source);
    materializeTrust(f.output, f.source); // A resumed phase must retain identical pins.
    for (const path of paths.slice(0, 6))
      assert.ok(
        readFileSync(join(f.source, path), 'utf8').includes(
          path.endsWith('codex_staging_candidate.go') ? trust.catalogSHA256 : trust.archiveSHA256
        ),
        path
      );
    assert.ok(readFileSync(join(repo, paths[1]), 'utf8').includes(publisher.archive));
    chmodSync(f.work, 0o755);
    execFileSync('bash', [
      join(f.output, 'install-codex-runtime.sh'),
      join(f.output, 'codex-runtime-linux-amd64.tar.gz'),
      join(f.work, 'installed'),
    ]);
    assert.equal(
      execFileSync(join(f.work, 'installed/current/bin/codex'), ['--version'], {
        encoding: 'utf8',
      }).trim(),
      'codex-cli 0.160.0-sam-c2.2'
    );
  } finally {
    rmSync(f.work, { recursive: true, force: true });
  }
});
test('rejects changed build payload and never mutates checkout for tampered installer', () => {
  const f = fixture();
  try {
    writeFileSync(join(f.review, 'codex'), 'tampered');
    assert.throws(() => packageRuntime(f.review, f.output, f.source), /manifest mismatch/);
  } finally {
    rmSync(f.work, { recursive: true, force: true });
  }
  const g = fixture();
  try {
    packageRuntime(g.review, g.output, g.source);
    const installer = join(g.output, 'install-codex-runtime.sh');
    writeFileSync(installer, '#!/bin/bash\nexit 0\n');
    const path = join(g.output, 'installation-codex-trust.json');
    const manifest = JSON.parse(readFileSync(path));
    manifest.installerSHA256 = digest(readFileSync(installer));
    writeFileSync(path, JSON.stringify(manifest));
    assert.throws(() => materializeTrust(g.output, g.source), /reviewed template/);
    assert.ok(readFileSync(join(g.source, paths[1]), 'utf8').includes(publisher.archive));
  } finally {
    rmSync(g.work, { recursive: true, force: true });
  }
});
test('update explicitly pins and retains previous installation runtime', () => {
  const f = fixture(),
    g = fixture();
  try {
    const previous = packageRuntime(f.review, f.output, f.source);
    const sumsPath = join(g.review, 'SHA256SUMS');
    const before = readFileSync(join(g.review, 'BUILD-PROVENANCE'));
    const after = Buffer.from('second installation build');
    writeFileSync(join(g.review, 'BUILD-PROVENANCE'), after);
    writeFileSync(sumsPath, readFileSync(sumsPath, 'utf8').replace(digest(before), digest(after)));
    const next = packageRuntime(g.review, g.output, g.source, previous);
    assert.notEqual(next.identity, previous.identity);
    materializeTrust(g.output, g.source);
    const route = readFileSync(join(g.source, 'apps/api/src/routes/codex-runtime.ts'), 'utf8');
    assert.ok(route.includes(previous.archiveSHA256));
    chmodSync(f.work, 0o755);
    const destination = join(f.work, 'installed');
    execFileSync('bash', [
      join(f.output, 'install-codex-runtime.sh'),
      join(f.output, 'codex-runtime-linux-amd64.tar.gz'),
      destination,
    ]);
    execFileSync('bash', [
      join(g.output, 'install-codex-runtime.sh'),
      join(g.output, 'codex-runtime-linux-amd64.tar.gz'),
      destination,
    ]);
    assert.equal(
      execFileSync('readlink', [join(destination, 'current')], { encoding: 'utf8' }).trim(),
      `releases/${next.identity}`
    );
    assert.equal(
      execFileSync('readlink', [join(destination, 'previous')], { encoding: 'utf8' }).trim(),
      `releases/${previous.identity}`
    );
    const h = fixture();
    try {
      const provenancePath = join(h.review, 'BUILD-PROVENANCE');
      const oldProvenance = readFileSync(provenancePath);
      const thirdProvenance = Buffer.from('third installation build');
      writeFileSync(provenancePath, thirdProvenance);
      const sums = join(h.review, 'SHA256SUMS');
      writeFileSync(
        sums,
        readFileSync(sums, 'utf8').replace(digest(oldProvenance), digest(thirdProvenance))
      );
      const third = packageRuntime(h.review, h.output, h.source, next);
      materializeTrust(h.output, h.source);
      execFileSync('bash', [
        join(h.output, 'install-codex-runtime.sh'),
        join(h.output, 'codex-runtime-linux-amd64.tar.gz'),
        destination,
      ]);
      assert.equal(
        execFileSync('readlink', [join(destination, 'current')], { encoding: 'utf8' }).trim(),
        `releases/${third.identity}`
      );
      assert.equal(
        execFileSync('readlink', [join(destination, 'previous')], { encoding: 'utf8' }).trim(),
        `releases/${next.identity}`
      );
    } finally {
      rmSync(h.work, { recursive: true, force: true });
    }
  } finally {
    rmSync(f.work, { recursive: true, force: true });
    rmSync(g.work, { recursive: true, force: true });
  }
});
