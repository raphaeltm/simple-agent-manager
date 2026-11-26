import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const ROOT = new URL('../..', import.meta.url);
const SCRIPT = 'scripts/deploy/pulumi-stack-urns.sh';
const CANARY = 'CANARY-not-a-urn-value';

/**
 * `pulumi stack --show-urns` as Pulumi 3.278 prints it (captured from a local file backend), with
 * a non-secret output value replaced by a canary: the lister must pass URNs on and nothing else.
 */
const SHOW_URNS = `Current stack is prod:
    Managed by 07774fba56dd
    Last updated: now (2026-11-26 15:34:39.732843636 +0000 UTC)
    Pulumi version used: v3.278.0
    Secrets provider: passphrase
Current stack resources (4):
    TYPE                                NAME
    pulumi:pulumi:Stack                 sam-infra-prod
    │  URN: urn:pulumi:prod::sam-infra::pulumi:pulumi:Stack::sam-infra-prod
    ├─ random:index/randomId:RandomId   encryption-key
    │     URN: urn:pulumi:prod::sam-infra::random:index/randomId:RandomId::encryption-key
    ├─ tls:index/privateKey:PrivateKey  jwt-signing-key
    │     URN: urn:pulumi:prod::sam-infra::tls:index/privateKey:PrivateKey::jwt-signing-key
    └─ pulumi:providers:random          default_4_21_4
          URN: urn:pulumi:prod::sam-infra::pulumi:providers:random::default_4_21_4

Current stack outputs (2):
    OUTPUT          VALUE
    encryptionKey   [secret]
    installationId  ${CANARY}

Use \`pulumi stack select\` to change stack; \`pulumi stack ls\` lists known ones
`;

function fakePulumi(body: string): { dir: string; argsFile: string } {
  const dir = mkdtempSync(join(tmpdir(), 'sam-stack-urns-'));
  const argsFile = join(dir, 'args.txt');
  const fixture = join(dir, 'show-urns.txt');
  writeFileSync(fixture, SHOW_URNS);
  const pulumi = join(dir, 'pulumi');
  writeFileSync(
    pulumi,
    `#!/bin/bash\nprintf '%s\\n' "$*" >> "${argsFile}"\n${body.replace('$FIXTURE', fixture)}\n`
  );
  chmodSync(pulumi, 0o755);
  return { dir, argsFile };
}

function run(dir: string) {
  return spawnSync('bash', [SCRIPT], {
    cwd: ROOT,
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
    encoding: 'utf8',
  });
}

describe('pulumi-stack-urns.sh', () => {
  it('prints only the URNs, never output values, and asks Pulumi for URNs only', () => {
    const { dir, argsFile } = fakePulumi('cat "$FIXTURE"');
    const result = run(dir);

    expect(result.status).toBe(0);
    expect(result.stdout.trim().split('\n')).toEqual([
      'urn:pulumi:prod::sam-infra::pulumi:pulumi:Stack::sam-infra-prod',
      'urn:pulumi:prod::sam-infra::random:index/randomId:RandomId::encryption-key',
      'urn:pulumi:prod::sam-infra::tls:index/privateKey:PrivateKey::jwt-signing-key',
      'urn:pulumi:prod::sam-infra::pulumi:providers:random::default_4_21_4',
    ]);
    expect(result.stdout + result.stderr).not.toContain(CANARY);
    expect(readFileSync(argsFile, 'utf8').trim()).toBe('stack --show-urns');
  });

  it('fails, rather than reporting an empty stack, when Pulumi cannot read the stack', () => {
    const { dir } = fakePulumi('echo "error: no stack selected" >&2; exit 255');
    const result = run(dir);

    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('no stack selected');
  });

  it('fails when the URNs it found do not match the resource count Pulumi states', () => {
    const { dir } = fakePulumi('sed "/encryption-key$/d" "$FIXTURE"');
    const result = run(dir);

    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('stated: 4, URNs found: 3');
  });

  it('fails on a listing without the resource count header', () => {
    const { dir } = fakePulumi('grep "URN:" "$FIXTURE"');
    const result = run(dir);

    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe('');
  });

  it('prints nothing for a stack with no resources', () => {
    const { dir } = fakePulumi(
      "printf 'Current stack resources (0):\\n    No resources currently in this stack\\n'"
    );
    const result = run(dir);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
  });
});

describe('workflows list Pulumi resources by URN, never by exporting state', () => {
  it.each(['teardown.yml', 'pulumi-state-repair.yml'])('%s uses the URN lister', (name) => {
    const text = readFileSync(new URL(`.github/workflows/${name}`, ROOT), 'utf8');
    const code = text
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'))
      .join('\n');

    expect(code).toContain('bash ../scripts/deploy/pulumi-stack-urns.sh');
    expect(code).not.toMatch(/\bpulumi\s+stack\s+export\b/);
    expect(code).not.toMatch(/--show-ids\b/);
  });
});
