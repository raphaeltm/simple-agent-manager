import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  isScannedPath,
  type RuleId,
  RULES,
  scanRepository,
  scanText,
} from './check-no-secret-readback';

const OPEN_TASK = 'tasks/backlog/2026-11-17-remove-pulumi-secret-readback.md';
const isOpen = (task: string) => task === OPEN_TASK;

/** The staging2 bootstrap step as it shipped (deploy-reusable.yml before policy 795e72a6). */
const STAGING2_BOOTSTRAP_STEP = `      - name: Bootstrap Secondary Installation
        working-directory: infra
        run: |
          read_output() {
            local value
            value="$(pulumi stack output --stack "$1" "$2" --show-secrets)"
            printf '%s' "$value"
          }
          TARGET_ENCRYPTION_KEY="$(read_output "$TARGET_STACK" encryptionKey)"
          echo "::add-mask::$TARGET_ENCRYPTION_KEY"
          cd .. && pnpm tsx scripts/deploy/bootstrap-staging-installation.ts bootstrap
`;

/** Its credential helper: decrypting the primary's platform credentials in the runner. */
const STAGING2_DECRYPT_HELPER = `export async function decryptToken(ciphertext: string, iv: string, keyBase64: string) {
  const key = await crypto.subtle.importKey('raw', base64ToBytes(keyBase64), 'AES-GCM', false, ['decrypt']);
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: base64ToBytes(iv) }, key, base64ToBytes(ciphertext));
  return new TextDecoder().decode(plaintext);
}
`;

const STAGING2_DECRYPT_IMPORT = `import {
  decryptToken,
  encryptToken,
} from './bootstrap-installation-credentials';
`;

function rulesOf(text: string, file = 'x.sh'): RuleId[] {
  return scanText(file, text, isOpen).findings.map((finding) => finding.rule);
}

/** Lines each rule must catch; every RULES entry must be the only match for at least one. */
const POSITIVE: Array<[string, RuleId]> = [
  ['value="$(pulumi stack output --stack "$1" "$2" --show-secrets)"', 'show-secrets'],
  ['pulumi stack export --show-secrets > state.json', 'show-secrets'],
  ['const outputs = await stack.outputs({ showSecrets: true });', 'show-secrets'],
  ['const plaintext = await crypto.subtle.decrypt(params, key, data);', 'decryption'],
  ["const decipher = createDecipheriv('aes-256-gcm', key, iv);", 'decryption'],
  ["const value = require('./crypto').decryptCredential(row);", 'decryption'],
  ['set -x', 'xtrace'],
  ['          set -euxo pipefail', 'xtrace'],
  ['set -o xtrace', 'xtrace'],
  ['bash -o xtrace scripts/deploy/configure-secrets.sh staging', 'xtrace'],
  ['RUN set -eux; \\\\', 'xtrace'],
  ['        shell: bash -x {0}', 'xtrace'],
  ['bash -x scripts/deploy/configure-secrets.sh staging', 'xtrace'],
  ['        run: /bin/bash -x script.sh', 'xtrace'],
  ['/usr/bin/bash -x script.sh', 'xtrace'],
  ['dash -x deploy.sh', 'xtrace'],
  ['/bin/ksh -x deploy.sh', 'xtrace'],
  ['          env', 'env-dump'],
  ['env | sort', 'env-dump'],
  ['export -p', 'env-dump'],
  ['declare -p', 'env-dump'],
  ['printenv CF_API_TOKEN', 'env-dump'],
  ['        run: env', 'env-dump'],
  ['env -0', 'env-dump'],
  ['env -u PATH', 'env-dump'],
  ['        run: /usr/bin/env', 'env-dump'],
  ['/usr/bin/env -0', 'env-dump'],
  ['/usr/bin/printenv', 'env-dump'],
  ['export', 'env-dump'],
  ['command env', 'env-dump'],
  ['declare -p SECRET_NAME', 'env-dump'],
  ['typeset -p -- SECRET_NAME', 'env-dump'],
  ['        run: typeset -p CF_API_TOKEN | cat', 'env-dump'],
  ['sudo -E env', 'env-dump'],
  ['        run: sudo -u runner printenv', 'env-dump'],
  ['sudo --preserve-env env | sort', 'env-dump'],
  ['env ADDED=1', 'env-dump'],
  ['        run: env -i ADDED=1 | sort', 'env-dump'],
  ['        run: command printenv', 'env-dump'],
  ['sudo env | sort', 'env-dump'],
  ['set', 'env-dump'],
  ['        run: set | sort', 'env-dump'],
  ['declare -x', 'env-dump'],
  ['typeset -px | sort', 'env-dump'],
  ['env --unset=PATH | sort', 'env-dump'],
  ['        run: env --null | sort', 'env-dump'],
  ['      - run: printenv | sort', 'env-dump'],
  ['cd infra && env | grep KEY', 'env-dump'],
  ['echo "$(env)"', 'env-dump'],
  ['        run: echo "$(printenv)" > env.txt', 'env-dump'],
  ['echo "`env`"', 'env-dump'],
  ['(env) | sort', 'env-dump'],
  ['dump=$( env -0 )', 'env-dump'],
  ['echo "$(declare -p CF_API_TOKEN)"', 'env-dump'],
  ['pulumi config get encryptionKey --stack staging', 'show-secrets'],
  ['const outputs = await stack.outputs({ showSecrets });', 'show-secrets'],
  ["const plain = await crypto.subtle['decrypt'](params, key, data);", 'decryption'],
  ['const plain = await crypto.subtle?.decrypt(params, key, data);', 'decryption'],
  ["const plain = await subtle?.['decrypt'](params, key, data);", 'decryption'],
  ["const enc = await import('../../apps/api/src/services/encryption');", 'decryption'],
  ["const { decrypt: open } = require('../api/src/services/encryption.js');", 'decryption'],
  ['set -e -x', 'xtrace'],
  ['set -euo pipefail -x', 'xtrace'],
  ['set -eo xtrace', 'xtrace'],
  ['set -o pipefail -o xtrace', 'xtrace'],
  ['bash -e -x scripts/deploy/configure-secrets.sh staging', 'xtrace'],
  ['export SHELLOPTS=errexit:xtrace', 'xtrace'],
  ['exec 9>trace.log; BASH_XTRACEFD=9', 'xtrace'],
  ['trap \'echo "$BASH_COMMAND"\' DEBUG', 'xtrace'],
];

/** Nearby shapes that must not be reported. */
const NEGATIVE = [
  'R2_BUCKET=$(pulumi stack output r2Name)',
  'pulumi stack output --json > outputs.json',
  'set -euo pipefail',
  'set -e',
  "bash -c 'echo hi'",
  'ssh -x host true',
  '        env:',
  'environment: ${{ inputs.environment }}',
  'export DEPLOY_ENV=staging',
  'declare -A seen=()',
  "import { encryptToken, hmacApiToken } from './credentials';",
  'const ciphertext = await crypto.subtle.encrypt(params, key, data);',
  '# Never use --show-secrets or set -x here.',
  '// decryptToken used to live here; see policy 795e72a6.',
  ' * set -x is banned in workflows.',
  'echo "::add-mask::$TARGET_ENCRYPTION_KEY"',
  "node -e 'process.stdout.write(JSON.stringify({ token: process.env.SMOKE_TEST_TOKEN }))'",
  '        run: envsubst < template > out',
  'pnpm --filter @simple-agent-manager/api exec wrangler deploy --env "$DEPLOY_ENV"',
  'pulumi config set workersDevSubdomain "$WORKERS_DEV_SUBDOMAIN"',
  'const outputs = await stack.outputs({ showSecrets: false });',
  'bash scripts/deploy/configure-secrets.sh "$DEPLOY_ENV"',
  'set -e; grep -x needle file',
  'trap cleanup EXIT',
  'env -u HOME node deploy.mjs',
  'env -i PATH="$PATH" bash run.sh',
  '/usr/bin/env node scripts/deploy/run.mjs',
  'bash scripts/ci/x.sh -x-ray-mode',
  'set -euo pipefail; set -- "$@"',
  'set +e',
  'command -v node',
  'sudo env FOO=1 make deploy',
  'sudo -u runner make deploy',
  'declare -a items=(a b)',
  'declare -r MAX=3',
  'echo "$(env node --version)"',
  'NODE=$(command -v node)',
  'ENV_NAME=$(environment_name)',
  'echo "$(set -o)" | grep pipefail',
];

describe('check-no-secret-readback rules', () => {
  it('fails on the staging2 bootstrap pattern it exists to stop', () => {
    expect(rulesOf(STAGING2_BOOTSTRAP_STEP, '.github/workflows/deploy-reusable.yml')).toEqual([
      'show-secrets',
    ]);
    expect(rulesOf(STAGING2_DECRYPT_HELPER, 'scripts/deploy/x.ts')).toEqual(['decryption']);
    expect(rulesOf(STAGING2_DECRYPT_IMPORT, 'scripts/deploy/y.ts')).toEqual(['decryption']);
  });

  it.each(POSITIVE)('reports %s', (line, rule) => {
    expect(rulesOf(line)).toEqual([rule]);
  });

  it.each(NEGATIVE)('does not report %s', (line) => {
    expect(rulesOf(line)).toEqual([]);
  });

  it.each([
    ["import { decryptToken } from './bootstrap-installation-credentials';", 1],
    [STAGING2_DECRYPT_IMPORT, 1],
    ["const x = 1;\nexport { decryptCredential } from './crypto';", 2],
    ["import { encrypt as seal } from '../../apps/api/src/services/encryption';", 1],
    ["import {\n  encrypt,\n} from '../../apps/api/src/services/encryption.ts';", 1],
    ["const { decryptCredential } = await import('./crypto');", 1],
    ["const { decryptToken: open } = require('./crypto');", 1],
    ["const x = 1;\nconst {\n  encryptToken,\n  decryptToken,\n} = require('./crypto');", 2],
  ])('reports a decrypt import: %s', (text, line) => {
    const result = scanText('x.ts', text, isOpen);
    expect(result.findings.map((finding) => [finding.rule, finding.line])).toEqual([
      ['decryption', line],
    ]);
  });

  it.each([
    "import { encryptToken } from './credentials';\nimport { readFileSync } from 'node:fs';",
    "// import { decryptToken } from './credentials';",
    "const { encryptToken } = require('./credentials');",
  ])('does not report the import %s', (text) => {
    expect(scanText('x.ts', text, isOpen).findings).toEqual([]);
  });

  it('reports a type named Decrypt* too, rather than telling types and helpers apart', () => {
    const text = "import type { DecryptedCredential } from './types';";
    expect(scanText('x.ts', text, isOpen).findings.map((finding) => finding.rule)).toEqual([
      'decryption',
    ]);
  });

  it('needs every pattern: each one is the only match for some reintroduced line', () => {
    const soleMatches = new Set<number>();
    for (const [line] of POSITIVE) {
      const matching = RULES.map((rule, index) => (rule.pattern.test(line) ? index : -1)).filter(
        (index) => index >= 0
      );
      if (matching.length === 1) soleMatches.add(matching[0]);
    }
    expect([...soleMatches].sort((a, b) => a - b)).toEqual(RULES.map((_rule, index) => index));
  });
});

describe('statements split across lines', () => {
  it.each<[string, string, RuleId, number]>([
    ['x.ts', 'const plain = await crypto.subtle\n  .decrypt(params, key, data);', 'decryption', 1],
    ['x.ts', 'const plain = await crypto.subtle.\n  decrypt(params, key, data);', 'decryption', 1],
    [
      'x.ts',
      "const plain = await crypto\n  .subtle['decrypt'](params, key, data);",
      'decryption',
      1,
    ],
    ['x.sh', 'echo start\nset \\\n  -x\necho done', 'xtrace', 2],
    [
      'x.yml',
      "        run: |\n          node --input-type=module <<'JS'\n          const p = await crypto.subtle\n            .decrypt(a, b, c);\n          JS",
      'decryption',
      3,
    ],
    [
      'x.sh',
      "node --input-type=module <<'JS'\nconst p = await crypto.subtle\n  ['decrypt'](a, b, c);\nJS",
      'decryption',
      2,
    ],
    [
      'x.sh',
      'pulumi stack output \\\n  --stack staging \\\n  --show-secrets encryptionKey',
      'show-secrets',
      1,
    ],
    ['x.yml', '        run: |\n          bash \\\n            -x deploy.sh', 'xtrace', 2],
  ])('reports %s %j', (file, text, rule, line) => {
    expect(
      scanText(file, text, isOpen).findings.map((finding) => [finding.rule, finding.line])
    ).toEqual([[rule, line]]);
  });

  it.each([
    ['x.ts', 'const ciphertext = await crypto.subtle\n  .encrypt(params, key, data);'],
    ['x.sh', 'pulumi stack output \\\n  --stack staging \\\n  r2Name'],
    ['x.sh', 'set -e\n-x is a flag name in this heredoc'],
    ['x.sh', 'echo crypto.subtle\n[ "$x" = env ]'],
  ])('does not report %s %j', (file, text) => {
    expect(scanText(file, text, isOpen).findings).toEqual([]);
  });
});

describe('tracing shebangs', () => {
  it.each(['#!/bin/bash -x', '#!/usr/bin/env -S bash -eux', '#!/bin/sh -x'])(
    'reports %s on the first line',
    (shebang) => {
      expect(rulesOf(`${shebang}\necho hi`)).toEqual(['xtrace']);
    }
  );

  it.each(['#!/bin/bash', '#!/usr/bin/env bash', '#!/bin/sh -e'])(
    'does not report %s',
    (shebang) => {
      expect(rulesOf(`${shebang}\necho hi`)).toEqual([]);
    }
  );

  it('does not treat a later comment as a shebang', () => {
    expect(rulesOf('echo hi\n#!/bin/bash -x')).toEqual([]);
  });
});

describe('JS/TS files', () => {
  it.each([
    'const target = process.env.TARGET || env;',
    "headers.set('x-trace', '1');",
    'seen.set(key, -x);',
    "const shell = 'bash -x';",
  ])('do not get shell-only rules: %s', (line) => {
    expect(rulesOf(line, 'scripts/deploy/x.ts')).toEqual([]);
  });

  it('still get the shared rules', () => {
    expect(rulesOf("execSync('set -x; deploy');", 'scripts/deploy/x.ts')).toEqual(['xtrace']);
    expect(rulesOf('run(["pulumi", "stack", "output", "--show-secrets"]);', 'infra/x.ts')).toEqual([
      'show-secrets',
    ]);
  });

  it('import pass also runs on workflow YAML with inline JS', () => {
    const yaml =
      "        run: |\n          node --input-type=module <<'JS'\n          import { decryptToken } from './scripts/deploy/x.mjs';\n          JS";
    expect(scanText('.github/workflows/x.yml', yaml, isOpen).findings).toEqual([
      expect.objectContaining({ rule: 'decryption', line: 3 }),
    ]);
  });
});

describe('legacy-read markers', () => {
  const read = 'value="$(pulumi stack output "$name" --show-secrets)"';

  it('accepts a read whose marker names an open task, and reports it as tracked', () => {
    const result = scanText('s.sh', `# sam:secret-readback-allowed ${OPEN_TASK}\n${read}`, isOpen);
    expect(result.findings).toEqual([]);
    expect(result.allowed).toEqual([
      { file: 's.sh', line: 2, rule: 'show-secrets', text: read, task: OPEN_TASK },
    ]);
  });

  it('rejects a marker naming an archived or missing task, and reports the marker', () => {
    const archived = 'tasks/archive/2026-11-17-remove-pulumi-secret-readback.md';
    const result = scanText('s.sh', `# sam:secret-readback-allowed ${archived}\n${read}`, isOpen);
    expect(result.findings.map((finding) => finding.rule)).toEqual(['show-secrets']);
    expect(result.invalidMarkers).toEqual([{ file: 's.sh', line: 1, task: archived }]);
  });

  it('still reports another rule on the excused line', () => {
    const text = `# sam:secret-readback-allowed ${OPEN_TASK}\nset -x; ${read}`;
    const result = scanText('s.sh', text, isOpen);
    expect(result.findings.map((finding) => finding.rule)).toEqual(['xtrace']);
    expect(result.allowed.map((read) => read.rule)).toEqual(['show-secrets']);
  });

  it('excuses only the line directly below the marker', () => {
    const below = [`# sam:secret-readback-allowed ${OPEN_TASK}`, read].join('\n');
    expect(scanText('s.sh', below, isOpen).findings).toHaveLength(0);
    const further = [`# sam:secret-readback-allowed ${OPEN_TASK}`, 'a', read].join('\n');
    expect(scanText('s.sh', further, isOpen).findings).toHaveLength(1);
  });

  it.each([
    ['set -x', 'xtrace'],
    ['env', 'env-dump'],
    ['const p = await crypto.subtle.decrypt(a, b, c);', 'decryption'],
  ])('never excuses %s, even on a marked line', (line, rule) => {
    const text = `# sam:secret-readback-allowed ${OPEN_TASK}\n${line}`;
    const result = scanText('s.sh', text, isOpen);
    expect(result.findings.map((finding) => finding.rule)).toEqual([rule]);
    expect(result.allowed).toEqual([]);
  });
});

describe('scanRepository', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
  });

  function repo(files: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), 'sam-no-secret-readback-'));
    roots.push(root);
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    }
    return root;
  }

  it('finds the reintroduced bootstrap in a workflow and its helper in a deploy script', () => {
    const result = scanRepository(
      repo({
        '.github/workflows/deploy-reusable.yml': `jobs:\n  deploy:\n    steps:\n${STAGING2_BOOTSTRAP_STEP}`,
        'scripts/deploy/bootstrap-installation-credentials.ts': STAGING2_DECRYPT_HELPER,
        'scripts/deploy/bootstrap-staging-installation.ts': STAGING2_DECRYPT_IMPORT,
        // Not scanned: tests, other trees and other file types.
        'scripts/quality/bootstrap.test.ts': STAGING2_DECRYPT_HELPER,
        'apps/api/src/services/encryption.ts': STAGING2_DECRYPT_HELPER,
        'infra/README.md': 'pulumi stack output --show-secrets',
      })
    );
    expect(
      result.findings.map((finding) => `${finding.file}:${finding.line} ${finding.rule}`)
    ).toEqual([
      '.github/workflows/deploy-reusable.yml:9 show-secrets',
      'scripts/deploy/bootstrap-installation-credentials.ts:3 decryption',
      'scripts/deploy/bootstrap-staging-installation.ts:1 decryption',
    ]);
    expect(result.files).toBe(3);
  });

  it('scans Dockerfiles as shell', () => {
    const result = scanRepository(
      repo({
        'scripts/e2e/workspace-mock/Dockerfile': 'FROM node:22\nRUN set -eux; npm ci\nRUN env\n',
      })
    );
    expect(result.findings.map((finding) => `${finding.line} ${finding.rule}`)).toEqual([
      '2 xtrace',
      '3 env-dump',
    ]);
  });

  it('accepts a marked read only while its task file is open in the repository', () => {
    const files = {
      'scripts/deploy/configure-secrets.sh': `# sam:secret-readback-allowed ${OPEN_TASK}\npulumi stack output k --show-secrets\n`,
    };
    const withTask = scanRepository(repo({ ...files, [OPEN_TASK]: '# task\n' }));
    expect(withTask.findings).toEqual([]);
    expect(withTask.allowed).toHaveLength(1);
    const withoutTask = scanRepository(repo(files));
    expect(withoutTask.findings).toHaveLength(1);
    expect(withoutTask.invalidMarkers).toHaveLength(1);
  });

  it('does not let an open task excuse a read in a file it is not pinned to', () => {
    const result = scanRepository(
      repo({
        [OPEN_TASK]: '# task\n',
        'scripts/deploy/new-script.sh': `# sam:secret-readback-allowed ${OPEN_TASK}\npulumi stack output k --show-secrets\n`,
      })
    );
    expect(result.findings.map((finding) => finding.file)).toEqual([
      'scripts/deploy/new-script.sh',
    ]);
    expect(result.invalidMarkers).toHaveLength(1);
  });

  it('does not accept a marker naming an archived task, even though the file exists', () => {
    const archived = 'tasks/archive/2026-11-17-remove-pulumi-secret-readback.md';
    const result = scanRepository(
      repo({
        [archived]: '# done\n',
        'scripts/deploy/configure-secrets.sh': `# sam:secret-readback-allowed ${archived}\npulumi stack output k --show-secrets\n`,
      })
    );
    expect(result.findings.map((finding) => finding.rule)).toEqual(['show-secrets']);
    expect(result.invalidMarkers).toEqual([
      { file: 'scripts/deploy/configure-secrets.sh', line: 1, task: archived },
    ]);
  });

  it('passes on this repository with only the tracked configure-secrets read', () => {
    const result = scanRepository(join(import.meta.dirname, '..', '..'));
    expect(result.findings).toEqual([]);
    expect(result.invalidMarkers).toEqual([]);
    expect(result.files).toBeGreaterThan(100);
    expect(result.allowed.map((read) => `${read.file} ${read.rule} ${read.task}`)).toEqual([
      `scripts/deploy/configure-secrets.sh show-secrets ${OPEN_TASK}`,
    ]);
  });

  it('skips test files and itself', () => {
    expect(isScannedPath('scripts/quality/check-no-secret-readback.ts')).toBe(false);
    expect(isScannedPath('scripts/quality/foo.test.ts')).toBe(false);
    expect(isScannedPath('scripts/ci/test-devcontainer-volume-mount.sh')).toBe(true);
    expect(isScannedPath('scripts/deploy/configure-secrets.sh')).toBe(true);
    expect(isScannedPath('.github/workflows/deploy-reusable.yml')).toBe(true);
    expect(isScannedPath('infra/index.ts')).toBe(true);
    expect(isScannedPath('scripts/e2e/workspace-mock/Dockerfile')).toBe(true);
    expect(isScannedPath('scripts/ci/Dockerfile.fixture')).toBe(true);
    expect(isScannedPath('infra/app.Dockerfile')).toBe(true);
    expect(isScannedPath('scripts/ci/NotADockerfileReally.txt')).toBe(false);
  });
});
