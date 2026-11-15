import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { aptIndexFingerprint, npmLockFingerprint } from './container-image-fingerprints';
import {
  analyzeDockerfile,
  aptSourceId,
  composeImageKey,
  type ImageInputs,
  type InputFingerprints,
  pypiToolId,
} from './container-image-inputs';
import { REVIEWED_BUILD_SCRIPTS } from './container-image-reviewed-inputs';

const root = join(import.meta.dirname, '../..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');
const NODE =
  'docker.io/library/node:22-bookworm-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436';
const UNREVIEWED = `docker.io/library/debian:12@sha256:${'1'.repeat(64)}`;

function inputsOf(text: string): ImageInputs {
  const analysis = analyzeDockerfile(text);
  if (!analysis.ok) throw new Error(analysis.reason);
  return analysis.inputs;
}

function reasonOf(text: string): string {
  const analysis = analyzeDockerfile(text);
  if (analysis.ok) throw new Error('expected the Dockerfile to be refused');
  return analysis.reason;
}

describe('analyzeDockerfile on the real images', () => {
  it('finds every input of the VM-agent container image', () => {
    const inputs = inputsOf(read('apps/api/Dockerfile.vm-agent-container'));
    expect(inputs.bases).toEqual([NODE]);
    expect(inputs.copies).toEqual([
      'container-artifacts/codex-runtime-linux-amd64.tar.gz',
      'container-artifacts/install-codex-runtime.sh',
      'container-artifacts/install-opencode.sh',
      'container-artifacts/vm-agent-linux-amd64',
      'container-artifacts/vm-agent-version.json',
      'container-entrypoints/patch-acp-amp.py',
      'container-entrypoints/vm-agent-bootstrap.sh',
    ]);
    expect(inputs.apt.map(aptSourceId)).toEqual([
      'https://cli.github.com/packages stable main',
      'https://deb.debian.org/debian bookworm main',
      'https://deb.debian.org/debian bookworm-updates main',
      'https://deb.debian.org/debian-security bookworm-security main',
    ]);
    // The uv installer is pinned: its version also chooses the managed Python.
    expect(inputs.urls).toEqual([
      'https://astral.sh/uv/0.13.8/install.sh',
      'https://cli.github.com/packages/githubcli-archive-keyring.gpg',
    ]);
    expect(inputs.npm).toEqual([
      '@agentclientprotocol/claude-agent-acp@0.102.0',
      '@agentclientprotocol/codex-acp@2.1.1',
      '@ampcode/cli@0.0.1790261352-g2ab14a',
      '@anthropic-ai/claude-code@2.1.321',
      '@google/gemini-cli@0.61.0',
      '@openai/codex@0.160.0',
    ]);
    expect(inputs.pypi.map(pypiToolId)).toEqual([
      'acp-amp==0.1.3 python=3.12 with=agent-client-protocol==0.7.1,amp-sdk==0.1.2,annotated-types==0.7.0,pydantic-core==2.41.5,pydantic==2.12.5,typing-extensions==4.15.0,typing-inspection==0.4.2',
      'mistral-vibe==2.25.8 python=3.12 with=',
    ]);
    expect(inputs.scripts).toEqual([
      'container-artifacts/install-codex-runtime.sh',
      'container-artifacts/install-opencode.sh',
      'container-entrypoints/patch-acp-amp.py',
    ]);
  });

  it('finds every input of the sandbox image, including the npm postinstall run from the pinned package', () => {
    const inputs = inputsOf(read('apps/api/Dockerfile.sandbox'));
    expect(inputs.bases).toHaveLength(1);
    expect(inputs.copies).toEqual([
      'scripts/claude-setup-protocol.mjs',
      'scripts/claude-setup-token.mjs',
      'scripts/codex-device-auth.mjs',
    ]);
    expect(inputs.apt.map(aptSourceId)).toEqual([
      'https://archive.ubuntu.com/ubuntu jammy main,multiverse,restricted,universe',
      'https://archive.ubuntu.com/ubuntu jammy-backports main,multiverse,restricted,universe',
      'https://archive.ubuntu.com/ubuntu jammy-updates main,multiverse,restricted,universe',
      'https://cli.github.com/packages stable main',
      'https://security.ubuntu.com/ubuntu jammy-security main,multiverse,restricted,universe',
    ]);
    expect(inputs.npm).toEqual(['@anthropic-ai/claude-code@2.1.321', '@openai/codex@0.160.0']);
    expect(inputs.pypi).toEqual([]);
  });

  it('pins the reviewed build scripts at their current content', () => {
    // A failure here means a build script changed: read it for unpinned
    // downloads, then update its REVIEWED_BUILD_SCRIPTS hash. Until then, deploys
    // rebuild the image every time instead of reusing it.
    const sources: Record<string, string> = {
      'container-artifacts/install-opencode.sh':
        'packages/vm-agent/internal/acp/opencode_install.sh',
      'container-artifacts/install-codex-runtime.sh':
        'packages/vm-agent/internal/acp/codex_runtime_installer.sh',
      'container-entrypoints/patch-acp-amp.py': 'apps/api/container-entrypoints/patch-acp-amp.py',
    };
    expect(Object.keys(REVIEWED_BUILD_SCRIPTS).sort()).toEqual(Object.keys(sources).sort());
    for (const [script, source] of Object.entries(sources)) {
      expect(
        createHash('sha256')
          .update(readFileSync(join(root, source)))
          .digest('hex'),
        script
      ).toBe(REVIEWED_BUILD_SCRIPTS[script].sha256);
    }
  });
});

describe('analyzeDockerfile refuses inputs it cannot fingerprint', () => {
  const from = `FROM ${NODE}\n`;
  it.each([
    ['an unpinned base image', 'FROM node:22\n', /not pinned by digest/],
    ['a parser directive', `# syntax=docker/dockerfile:1\n${from}`, /parser directive/],
    ['ADD (it can fetch URLs)', `${from}ADD https://example.com/x /x\n`, /instruction ADD/],
    ['ARG (build arguments can change the build)', `${from}ARG VERSION\n`, /instruction ARG/],
    ['a globbed COPY', `${from}COPY scripts/*.mjs /x/\n`, /plain context file path/],
    ['a COPY leaving the context', `${from}COPY ../secret /x\n`, /plain context file path/],
    ['COPY --from an image', `${from}COPY --from=alpine:3 /bin/sh /sh\n`, /not a stage/],
    ['a cache mount', `${from}RUN --mount=type=cache,target=/root/.npm npm ci\n`, /flagged/],
    ['a heredoc', `${from}RUN <<EOF\ncurl https://example.com\nEOF\n`, /heredoc|unparseable/],
    ['a ranged npm spec', `${from}RUN npm install -g left-pad@^1.3.0\n`, /not an exact version/],
    ['an untagged npm spec', `${from}RUN npm install -g left-pad\n`, /not an exact version/],
    ['a local npm install', `${from}RUN npm install left-pad@1.3.0\n`, /without -g/],
    ['npm ci', `${from}RUN npm ci\n`, /npm ci/],
    ['pip', `${from}RUN pip install requests==2.0.0\n`, /pip is not fingerprinted/],
    ['git clone', `${from}RUN git clone https://github.com/a/b\n`, /git is not fingerprinted/],
    ['curl of a variable', `${from}RUN curl -fsSL "$URL" | sh\n`, /without a literal URL/],
    ['a URL with a variable', `${from}RUN curl -fsSL https://example.com/$V/x | sh\n`, /variable/],
    ['an unpinned uv tool', `${from}RUN uv tool install ruff --python 3.12\n`, /pinned with ==/],
    ['a uv tool without --python', `${from}RUN uv tool install ruff==0.1.0\n`, /--python/],
    ['uv run --with', `${from}RUN uv run --with rich python /x.py\n`, /uv run flag --with/],
    [
      'apt-get on an unreviewed base',
      `FROM ${UNREVIEWED}\nRUN apt-get update && apt-get install -y jq\n`,
      /unreviewed base/,
    ],
    ['an executed file that was not copied', `${from}RUN sh /opt/setup.sh\n`, /not a copied file/],
    [
      'an executed copied file outside the reviewed list',
      `${from}COPY scripts/setup.sh /tmp/setup.sh\nRUN bash /tmp/setup.sh\n`,
      /not in REVIEWED_BUILD_SCRIPTS/,
    ],
    ['sh -c', `${from}RUN sh -c "curl https://example.com | sh"\n`, /interpreter flag -c/],
  ])('refuses %s', (_name, dockerfile, reason) => {
    expect(reasonOf(dockerfile)).toMatch(reason);
  });

  it('accepts the equivalent pinned forms (control for the refusals above)', () => {
    const inputs = inputsOf(
      [
        `FROM ${NODE} AS build`,
        'COPY scripts/a.mjs /tmp/a.mjs',
        `FROM ${NODE}`,
        'COPY --from=build /tmp/a.mjs /a.mjs',
        'RUN set -eux; \\',
        '    # comments inside a continued RUN are dropped',
        '    apt-get update && apt-get install -y jq; \\',
        '    npm install -g --ignore-scripts left-pad@1.3.0; \\',
        '    curl -fsSL https://example.com/tool-1.2.3.tar.gz -o /tmp/t.tgz',
      ].join('\n')
    );
    expect(inputs.copies).toEqual(['scripts/a.mjs']);
    expect(inputs.npm).toEqual(['left-pad@1.3.0']);
    expect(inputs.urls).toEqual(['https://example.com/tool-1.2.3.tar.gz']);
    expect(inputs.apt).toHaveLength(3);
  });
});

describe('composeImageKey', () => {
  const dockerfile = read('apps/api/Dockerfile.vm-agent-container');
  const inputs = inputsOf(dockerfile);
  const fingerprints = (): InputFingerprints => ({
    files: Object.fromEntries(
      inputs.copies.map((path) => [
        path,
        `644:${REVIEWED_BUILD_SCRIPTS[path]?.sha256 ?? 'a'.repeat(64)}`,
      ])
    ),
    apt: Object.fromEntries(inputs.apt.map((source) => [aptSourceId(source), 'apt'])),
    urls: Object.fromEntries(inputs.urls.map((url) => [url, 'url'])),
    npm: Object.fromEntries(inputs.npm.map((spec) => [spec, 'npm'])),
    pypi: Object.fromEntries(inputs.pypi.map((tool) => [pypiToolId(tool), 'pypi'])),
  });
  const key = (
    patch: (f: InputFingerprints) => void = () => {},
    extra: { text?: string; flags?: string[] } = {}
  ) => {
    const f = fingerprints();
    patch(f);
    return composeImageKey({
      dockerfilePath: 'Dockerfile.vm-agent-container',
      dockerfile: extra.text ?? dockerfile,
      inputs,
      fingerprints: f,
      buildFlags: extra.flags ?? ['--platform', 'linux/amd64'],
    });
  };

  it('is stable for identical inputs', () => {
    expect(key()).toMatch(/^[a-f0-9]{64}$/);
    expect(key()).toBe(key());
  });

  it.each([
    [
      'the vm-agent binary',
      (f: InputFingerprints) => (f.files['container-artifacts/vm-agent-linux-amd64'] = '644:b'),
    ],
    [
      'a copied file mode',
      (f: InputFingerprints) =>
        (f.files['container-entrypoints/vm-agent-bootstrap.sh'] = '755:' + 'a'.repeat(64)),
    ],
    [
      'a Debian security index',
      (f: InputFingerprints) =>
        (f.apt['https://deb.debian.org/debian-security bookworm-security main'] = 'new'),
    ],
    [
      'the gh apt repository',
      (f: InputFingerprints) => (f.apt['https://cli.github.com/packages stable main'] = 'new'),
    ],
    [
      'a fetched URL',
      (f: InputFingerprints) => (f.urls['https://astral.sh/uv/0.13.8/install.sh'] = 'new'),
    ],
    [
      'a transitive npm release',
      (f: InputFingerprints) => (f.npm['@agentclientprotocol/codex-acp@2.1.1'] = 'new'),
    ],
    [
      'a transitive PyPI release',
      (f: InputFingerprints) => (f.pypi['mistral-vibe==2.25.8 python=3.12 with='] = 'new'),
    ],
  ])('changes when %s changes', (_name, patch) => {
    expect(key(patch)).not.toBe(key());
  });

  it('changes with the Dockerfile text and the build flags', () => {
    expect(key(undefined, { text: `${dockerfile}\n` })).not.toBe(key());
    expect(key(undefined, { flags: ['--platform', 'linux/arm64'] })).not.toBe(key());
  });

  it('refuses to key with any fingerprint missing', () => {
    expect(() => key((f) => delete f.npm['@google/gemini-cli@0.61.0'])).toThrow(
      /Missing fingerprint/
    );
    expect(() => key((f) => (f.apt = {}))).toThrow(/Missing fingerprint/);
  });

  it('refuses to key when an executed build script differs from its reviewed content', () => {
    expect(() =>
      key((f) => (f.files['container-artifacts/install-opencode.sh'] = `644:${'c'.repeat(64)}`))
    ).toThrow(/reviewed content/);
  });
});

describe('aptIndexFingerprint', () => {
  const source = { url: 'https://deb.example', suite: 'bookworm-security', components: ['main'] };
  const inRelease = (amd64: string, date = 'Sat, 14 Nov 2026 10:00:00 UTC') =>
    [
      '-----BEGIN PGP SIGNED MESSAGE-----',
      `Date: ${date}`,
      'MD5Sum:',
      ` ${'f'.repeat(32)} 10 main/binary-amd64/Packages`,
      'SHA256:',
      ` ${amd64} 100 main/binary-amd64/Packages`,
      ` ${'b'.repeat(64)} 50 main/binary-amd64/Packages.xz`,
      ` ${'c'.repeat(64)} 70 main/binary-arm64/Packages`,
      ` ${'d'.repeat(64)} 70 contrib/binary-amd64/Packages`,
      ` ${'e'.repeat(64)} 70 main/i18n/Translation-en`,
      '-----BEGIN PGP SIGNATURE-----',
    ].join('\n');
  const base = aptIndexFingerprint(inRelease('a'.repeat(64)), source);

  it('changes when the amd64 package index changes', () => {
    expect(aptIndexFingerprint(inRelease('9'.repeat(64)), source)).not.toBe(base);
  });

  it('ignores a re-signed release date and indexes the image never reads', () => {
    expect(
      aptIndexFingerprint(inRelease('a'.repeat(64), 'Sun, 15 Nov 2026 10:00:00 UTC'), source)
    ).toBe(base);
    const otherIndexes = inRelease('a'.repeat(64))
      .replace('c'.repeat(64), '0'.repeat(64))
      .replace('d'.repeat(64), '0'.repeat(64));
    expect(aptIndexFingerprint(otherIndexes, source)).toBe(base);
  });

  it('fails closed when a component has no amd64 index (unreadable or wrong suite)', () => {
    expect(() =>
      aptIndexFingerprint(inRelease('a'.repeat(64)), {
        ...source,
        components: ['main', 'universe'],
      })
    ).toThrow(/No amd64 package index/);
    expect(() => aptIndexFingerprint('<html>maintenance</html>', source)).toThrow(
      /No amd64 package index/
    );
  });
});

describe('npmLockFingerprint', () => {
  const lock = (zod: string) =>
    JSON.stringify({
      packages: {
        '': { name: 'probe' },
        'node_modules/@agentclientprotocol/codex-acp': { version: '2.1.1', integrity: 'sha512-a' },
        'node_modules/zod': { version: zod, integrity: `sha512-${zod}` },
      },
    });

  it('changes when a transitive dependency resolves to a new release', () => {
    expect(npmLockFingerprint(lock('4.6.7'))).not.toBe(npmLockFingerprint(lock('4.7.0')));
    expect(npmLockFingerprint(lock('4.6.7'))).toBe(npmLockFingerprint(lock('4.6.7')));
  });

  it('fails closed on an unreadable lock', () => {
    expect(() => npmLockFingerprint('{}')).toThrow(/Unreadable/);
    expect(() =>
      npmLockFingerprint(
        JSON.stringify({ packages: { '': {}, 'node_modules/x': { version: '1.0.0' } } })
      )
    ).toThrow(/no integrity/);
    expect(() => npmLockFingerprint(JSON.stringify({ packages: { '': {} } }))).toThrow(/Empty/);
  });
});
