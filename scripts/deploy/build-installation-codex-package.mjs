// Package locally built reviewed sources. Trust is compiled into this installation,
// never accepted from a runtime environment variable or downloaded manifest.
import { createHash } from 'node:crypto';
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  mkdtempSync,
  copyFileSync,
  chmodSync,
  rmSync,
  existsSync,
  lstatSync,
} from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
export const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const publisher = {
  identity: 'sam-codex-acp-2.1.1-sam-c2.2+cli-0.160.0-sam-c2.2-codemode2',
  archive: '1fd3c07846581888284ed9c9d02bc1f51e3673610c3688d8da98db47030bfb95',
  catalog: '02c1b8818f856effeb90a076ace5ab70a9e25b81dadcbf78be000f53113c3b1e',
  notices: '1b8edf18ddd7ea418024c1feb8b48697fe4e408fba33c315ac79d2ab9ef4b7cd',
  size: 136245837,
};
const names = [
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
export function validatePrevious(previous, includeOlder = true) {
  if (
    !previous ||
    previous.version !== 1 ||
    !/^sam-codex-acp-2\.1\.1-sam-c2\.2\+cli-0\.160\.0-sam-c2\.2-codemode2-installation-[a-f0-9]{16}$/.test(
      previous.identity
    ) ||
    ['archiveSHA256', 'catalogSHA256', 'noticesSHA256'].some(
      (key) => !/^[a-f0-9]{64}$/.test(previous[key])
    ) ||
    !Number.isSafeInteger(previous.archiveBytes) ||
    previous.archiveBytes <= 0 ||
    previous.archiveBytes > 300 * 1024 * 1024
  )
    throw new Error('Invalid previous installation trust');
  const selected = Object.fromEntries(
    ['version', 'identity', 'archiveSHA256', 'catalogSHA256', 'noticesSHA256', 'archiveBytes'].map(
      (key) => [key, previous[key]]
    )
  );
  if (includeOlder && previous.previous)
    selected.previous = validatePrevious(previous.previous, false);
  return selected;
}
export function installerFor(trust, template) {
  let result = template;
  for (const [before, after] of [
    [publisher.identity, trust.identity],
    [publisher.archive, trust.archiveSHA256],
    [publisher.catalog, trust.catalogSHA256],
    [publisher.notices, trust.noticesSHA256],
    [String(publisher.size), String(trust.archiveBytes)],
  ])
    result = result.replaceAll(before, after);
  if (trust.previous) {
    const previous = validatePrevious(trust.previous);
    result = result
      .replace(
        "prior_identity='sam-codex-acp-1.13.1-sam-c2.1+cli-0.156.1-sam-c2.1-codemode2'",
        `prior_identity='${previous.identity}'`
      )
      .replace(
        "prior_catalog_hash='c984a43334aab0968f8a728e8944fd36f99a613e9402eef77243d5ca3ff56d09'",
        `prior_catalog_hash='${previous.catalogSHA256}'`
      )
      .replace(
        "prior_notices_hash='9f84f8c07cc6b2a3dfe7df75816e18896575e0a8f622b2cb778b826f8db4e056'",
        `prior_notices_hash='${previous.noticesSHA256}'`
      )
      .replace(
        "cli_version='0.156.1-sam-c2.1'; adapter_version='1.13.1-sam-c2.1'",
        "cli_version='0.160.0-sam-c2.2'; adapter_version='2.1.1-sam-c2.2'"
      );
    // The existing rollback link belongs to the predecessor's own predecessor.
    // Verify that pinned generation before replacing the link during this update.
    if (previous.previous) {
      const older = validatePrevious(previous.previous);
      const marker = 'if [[ -e "$root/previous" || -L "$root/previous" ]]; then';
      const reconciliation = `if [[ -L "$root/previous" && $(readlink -- "$root/previous") == 'releases/${older.identity}' ]]; then
  saved_identity=$prior_identity; saved_catalog=$prior_catalog_hash; saved_notices=$prior_notices_hash
  prior_identity='${older.identity}'; prior_catalog_hash='${older.catalogSHA256}'; prior_notices_hash='${older.noticesSHA256}'
  verify_prior || exit 1
  prior_identity=$saved_identity; prior_catalog_hash=$saved_catalog; prior_notices_hash=$saved_notices
  rm -- "$root/previous"
fi
`;
      result = result.replace(marker, reconciliation + marker);
    }
  }
  return result;
}
export function packageRuntime(review, output, repo, previous) {
  const bytes = new Map(
    names.map((name) => {
      const path = join(review, name);
      if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())
        throw new Error(`Invalid build input: ${name}`);
      return [name, readFileSync(path)];
    })
  );
  const manifest = readFileSync(join(review, 'SHA256SUMS'), 'utf8');
  const expected = names.map((name) => `${digest(bytes.get(name))}  ${name}\n`).join('');
  if (manifest !== expected) throw new Error('Build output manifest mismatch');
  const source = readFileSync(join(repo, 'scripts/diagnostics/pinned-codex-local.provenance'));
  if (!source.equals(bytes.get('SOURCE-PROVENANCE')))
    throw new Error('Unexpected source provenance');
  const provenance = source.toString().trim().split('\n');
  if (
    digest(bytes.get('codex-code-mode-host')) !== provenance[3].split(' ')[3] ||
    digest(bytes.get(names.at(-1))) !== provenance[4].split(' ')[2]
  )
    throw new Error('Upstream helper provenance mismatch');
  const identity = `${publisher.identity}-installation-${digest(Buffer.from(expected)).slice(0, 16)}`;
  mkdirSync(output, { recursive: true });
  const archive = join(output, 'codex-runtime-linux-amd64.tar.gz');
  if (existsSync(archive)) throw new Error('Archive output already exists');
  const work = mkdtempSync(join(tmpdir(), 'sam-installation-codex-'));
  try {
    const release = join(work, 'releases', identity);
    const notices = join(work, 'notices', identity);
    mkdirSync(join(release, 'payload'), { recursive: true });
    mkdirSync(join(release, 'bin'));
    mkdirSync(notices, { recursive: true });
    mkdirSync(join(work, 'catalog'));
    for (const name of ['codex', 'adapter.js', 'codex-code-mode-host', 'SOURCE-PROVENANCE'])
      writeFileSync(join(release, 'payload', name), bytes.get(name), {
        mode: name === 'codex' || name === 'codex-code-mode-host' ? 0o755 : 0o644,
      });
    writeFileSync(
      join(release, 'payload/SHA256SUMS'),
      ['codex', 'adapter.js', 'codex-code-mode-host']
        .map((name) => `${digest(bytes.get(name))}  ${name}\n`)
        .join('')
    );
    for (const name of ['codex', 'codex-acp']) {
      copyFileSync(
        join(repo, 'scripts/diagnostics/pinned-codex-bin', name),
        join(release, 'bin', name)
      );
      chmodSync(join(release, 'bin', name), 0o755);
    }
    const releaseNames = [
      'bin/codex',
      'bin/codex-acp',
      'payload/SHA256SUMS',
      'payload/SOURCE-PROVENANCE',
      'payload/adapter.js',
      'payload/codex',
      'payload/codex-code-mode-host',
    ];
    const catalog = releaseNames
      .map((name) => `${digest(readFileSync(join(release, name)))}  ${name}\n`)
      .join('');
    writeFileSync(join(work, 'catalog', `${identity}.sha256`), catalog);
    const noticeNames = names.filter(
      (name) => !['codex', 'adapter.js', 'codex-code-mode-host'].includes(name)
    );
    for (const name of noticeNames) writeFileSync(join(notices, name), bytes.get(name));
    writeFileSync(join(notices, 'SHA256SUMS'), expected);
    noticeNames.push('SHA256SUMS');
    const noticeManifest = noticeNames
      .map((name) => `${digest(readFileSync(join(notices, name)))}  ${name}\n`)
      .join('');
    writeFileSync(join(work, 'catalog', `${identity}.notices.sha256`), noticeManifest);
    // Explicit modes remove dependence on the builder's umask.
    execFileSync('/usr/bin/find', [
      work,
      '-type',
      'd',
      '-exec',
      '/usr/bin/chmod',
      '755',
      '--',
      '{}',
      '+',
    ]);
    execFileSync('/usr/bin/find', [
      work,
      '-type',
      'f',
      '-exec',
      '/usr/bin/chmod',
      'a+r,go-w',
      '--',
      '{}',
      '+',
    ]);
    const tar = join(output, 'runtime.tar');
    execFileSync('/usr/bin/tar', [
      '--sort=name',
      '--format=gnu',
      '--mtime=@0',
      '--owner=0',
      '--group=0',
      '--numeric-owner',
      '-cf',
      tar,
      '-C',
      work,
      '.',
    ]);
    execFileSync('/usr/bin/gzip', ['-n', tar]);
    const archiveBytes = readFileSync(`${tar}.gz`);
    writeFileSync(archive, archiveBytes, { flag: 'wx', mode: 0o644 });
    rmSync(`${tar}.gz`);
    const trust = {
      version: 1,
      identity,
      archiveSHA256: digest(archiveBytes),
      archiveBytes: archiveBytes.length,
      catalogSHA256: digest(Buffer.from(catalog)),
      noticesSHA256: digest(Buffer.from(noticeManifest)),
      sourceSHA256: digest(source),
      reviewSHA256: digest(Buffer.from(expected)),
    };
    if (previous) trust.previous = validatePrevious(previous);
    let installer = readFileSync(
      join(repo, 'packages/vm-agent/internal/acp/codex_runtime_installer.sh'),
      'utf8'
    );
    installer = installerFor(trust, installer);
    writeFileSync(join(output, 'install-codex-runtime.sh'), installer, { flag: 'wx', mode: 0o755 });
    trust.installerSHA256 = digest(Buffer.from(installer));
    writeFileSync(
      join(output, 'installation-codex-trust.json'),
      `${JSON.stringify(trust, null, 2)}\n`,
      { flag: 'wx', mode: 0o644 }
    );
    return trust;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
if (process.argv[1] === new URL(import.meta.url).pathname) {
  if (![5, 6].includes(process.argv.length))
    throw new Error('usage: package <review-dir> <output-dir> <source-checkout>');
  packageRuntime(
    ...process.argv.slice(2, 5).map((value) => resolve(value)),
    process.argv[5] ? JSON.parse(readFileSync(resolve(process.argv[5]), 'utf8')) : undefined
  );
}
