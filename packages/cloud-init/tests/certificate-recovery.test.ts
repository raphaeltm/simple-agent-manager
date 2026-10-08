import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { generateCloudInit } from '../src/generate';

function runBoot(statuses: string, valid = true) {
  const dir = mkdtempSync(join(tmpdir(), 'sam-cert-test-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const script = (name: string, content: string) =>
    writeFileSync(join(bin, name), '#!/bin/sh\n' + content, { mode: 0o755 });
  script('logger', 'printf "%s\\n" "$*" >> "$TEST_DIR/log"');
  script('sleep', 'printf "%s\\n" "$*" >> "$TEST_DIR/sleeps"');
  script(
    'openssl',
    `case "$1" in
    genrsa|req) while [ "$#" -gt 0 ]; do if [ "$1" = -out ]; then shift; printf 'local-key-or-csr' > "$1"; break; fi; shift; done ;;
    x509) exit ${valid ? 0 : 1} ;;
  esac`
  );
  script(
    'curl',
    `case "$*" in *boot-failure*) printf 'reported\\n' >> "$TEST_DIR/reports"; exit 0 ;; esac
n=$(cat "$TEST_DIR/count"); n=$((n+1)); echo "$n" > "$TEST_DIR/count"
code=$(echo "$STATUSES" | cut -d, -f"$n")
while [ "$#" -gt 0 ]; do if [ "$1" = -o ]; then shift; printf 'certificate' > "$1"; fi; shift; done
if [ "$code" = transport ]; then exit 28; fi
printf '%s' "$code"`
  );
  for (const file of ['log', 'sleeps', 'reports']) writeFileSync(join(dir, file), '');
  writeFileSync(join(dir, 'count'), '0');
  const yaml = generateCloudInit({
    nodeId: 'node-test',
    hostname: 'test',
    controlPlaneUrl: 'https://api.example.com',
    jwksUrl: 'https://api.example.com/jwks',
    callbackToken: 'CANARY-SECRET',
    originCaCertificateUrl: 'https://api.example.com/certificate',
    certMaxAttempts: '4',
    certBaseDelaySeconds: '2',
    certMaxDelaySeconds: '3',
    certRequestTimeoutSeconds: '5',
  });
  const parsed = YAML.parse(yaml) as { runcmd: string[] };
  const block = parsed.runcmd.find(
    (x) => typeof x === 'string' && x.includes('ORIGIN_CA_CERTIFICATE_URL=')
  )!;
  try {
    const result = spawnSync('/bin/sh', ['-c', block.replaceAll('/etc/sam/tls', dir)], {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        TEST_DIR: dir,
        STATUSES: statuses,
      },
      encoding: 'utf8',
    });
    return {
      status: result.status,
      calls: Number(readFileSync(join(dir, 'count'), 'utf8')),
      logs: readFileSync(join(dir, 'log'), 'utf8'),
      sleeps: readFileSync(join(dir, 'sleeps'), 'utf8'),
      reports: readFileSync(join(dir, 'reports'), 'utf8'),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('rendered POSIX certificate bootstrap', () => {
  it('recovers transient transport and server failures with capped exponential backoff', () => {
    const result = runBoot('transport,500,429,200');
    expect(result.status).toBe(0);
    expect(result.calls).toBe(4);
    expect(result.sleeps).toBe('2\n3\n3\n');
    expect(result.reports).toBe('');
    expect(result.logs).not.toContain('CANARY-SECRET');
  });
  it('reports exhausted failures and exits before starting the agent', () => {
    const result = runBoot('503,503,503,503');
    expect(result.status).toBe(1);
    expect(result.calls).toBe(4);
    expect(result.reports).toBe('reported\n');
  });
  it('does not retry permanent authentication rejection', () => {
    const result = runBoot('403');
    expect(result.status).toBe(1);
    expect(result.calls).toBe(1);
    expect(result.sleeps).toBe('');
  });
  it('rejects an invalid certificate even with HTTP 200', () => {
    const result = runBoot('200', false);
    expect(result.status).toBe(1);
    expect(result.reports).toBe('reported\n');
  });
});

describe('rendered agent download deadline', () => {
  it('reports a timed-out binary transfer and exits before chmod or agent startup', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sam-download-test-'));
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    const script = (name: string, content: string) =>
      writeFileSync(join(bin, name), '#!/bin/sh\n' + content, { mode: 0o755 });
    script('logger', 'cat >/dev/null');
    script('chmod', 'touch "$TEST_DIR/continued"');
    script(
      'curl',
      `case "$*" in
      *boot-failure*) printf 'reported' > "$TEST_DIR/report"; exit 0 ;;
    esac
    [ "$1" = --max-time ] && [ "$2" = 7 ] || exit 99
    exit 28`
    );
    const config = YAML.parse(
      generateCloudInit({
        nodeId: 'node-test',
        hostname: 'test',
        callbackToken: 'CANARY-SECRET',
        controlPlaneUrl: 'https://api.example.com',
        jwksUrl: 'https://api.example.com/jwks',
        agentDownloadTimeoutSeconds: '7',
      })
    ) as { runcmd: string[] };
    const block = config.runcmd.find((entry) => entry.includes('ARCH=$(uname -m)'));
    if (!block) throw new Error('Agent download block missing');
    try {
      const result = spawnSync('/bin/sh', ['-c', block], {
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TEST_DIR: dir },
        encoding: 'utf8',
        timeout: 2_000,
      });
      expect(result.status).toBe(28);
      expect(readFileSync(join(dir, 'report'), 'utf8')).toBe('reported');
      expect(() => readFileSync(join(dir, 'continued'))).toThrow();
      expect(result.stdout + result.stderr).not.toContain('CANARY-SECRET');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
