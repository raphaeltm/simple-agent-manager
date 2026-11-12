import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  assertContainerEngineReady,
  dockerfileCopySources,
  guidedLoginSettings,
  materialiseSandboxImageContext,
} from './guided-login.js';

const API_DIR = resolve(import.meta.dirname, '../../apps/api');

describe('guidedLoginSettings', () => {
  it('is off unless turned on', () => {
    expect(guidedLoginSettings({})).toBeNull();
    expect(guidedLoginSettings({ SAM_GUIDED_LOGIN: 'off' })).toBeNull();
  });

  it('defaults to gVisor and the basic instance type', () => {
    expect(guidedLoginSettings({ SAM_GUIDED_LOGIN: 'on' })).toEqual({
      runtime: 'runsc',
      instanceType: 'basic',
    });
  });

  it('accepts an explicit runtime, and refuses "default" (the socket proxy pins a named one)', () => {
    expect(
      guidedLoginSettings({ SAM_GUIDED_LOGIN: 'on', SAM_GUIDED_LOGIN_RUNTIME: 'kata' })?.runtime
    ).toBe('kata');
    expect(() =>
      guidedLoginSettings({ SAM_GUIDED_LOGIN: 'on', SAM_GUIDED_LOGIN_RUNTIME: 'default' })
    ).toThrow(/name the runtime/);
  });

  it('refuses malformed values', () => {
    expect(() => guidedLoginSettings({ SAM_GUIDED_LOGIN: 'yes please' })).toThrow(/on or off/);
    expect(() =>
      guidedLoginSettings({ SAM_GUIDED_LOGIN: 'on', SAM_GUIDED_LOGIN_RUNTIME: 'runsc --x' })
    ).toThrow(/OCI runtime/);
    expect(() =>
      guidedLoginSettings({ SAM_GUIDED_LOGIN: 'on', SAM_GUIDED_LOGIN_INSTANCE_TYPE: 'huge' })
    ).toThrow(/instance type/);
  });

  it('keeps the proxy uid (in the Docker socket group) apart from celld and sam-mx', () => {
    const on = { SAM_GUIDED_LOGIN: 'on' };
    // Compose defaults: celld 7101, sam-mx 7102, proxy 7103.
    expect(guidedLoginSettings(on)).not.toBeNull();
    expect(() => guidedLoginSettings({ ...on, SAM_DOCKER_PROXY_UID: '7102' })).toThrow(
      /SAM_MX_UID/
    );
    expect(() => guidedLoginSettings({ ...on, SAM_DOCKER_PROXY_UID: '7101' })).toThrow(/CELLD_UID/);
    expect(() => guidedLoginSettings({ ...on, CELLD_UID: '7103' })).toThrow(/CELLD_UID/);
    expect(() => guidedLoginSettings({ ...on, SAM_DOCKER_PROXY_UID: '0' })).toThrow(/root/);
    expect(() => guidedLoginSettings({ ...on, SAM_DOCKER_PROXY_UID: 'x' })).toThrow(/numeric/);
    expect(guidedLoginSettings({ ...on, SAM_DOCKER_PROXY_UID: '7200' })).not.toBeNull();
  });
});

describe('sandbox image build context', () => {
  it('lists the files the real Dockerfile.sandbox copies', () => {
    const sources = dockerfileCopySources(
      readFileSync(join(API_DIR, 'Dockerfile.sandbox'), 'utf8')
    );
    expect(sources.length).toBeGreaterThan(0);
    for (const source of sources) expect(source.startsWith('scripts/')).toBe(true);
  });

  it('refuses COPY forms it cannot materialise', () => {
    expect(() => dockerfileCopySources('COPY --from=build /a /b')).toThrow(/not supported/);
    expect(() => dockerfileCopySources('COPY ../secret /x')).toThrow(/plain relative/);
    expect(() => dockerfileCopySources('COPY scripts/*.mjs /x/')).toThrow(/plain relative/);
  });

  it('materialises only the Dockerfile and its sources, never .dev.vars', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'sam-guided-login-'));
    const image = materialiseSandboxImageContext(API_DIR, projectDir);
    expect(image).toBe('containers/sandbox/Dockerfile');
    const dir = join(projectDir, 'containers/sandbox');
    const sources = dockerfileCopySources(readFileSync(join(dir, 'Dockerfile'), 'utf8'));
    expect(readdirSync(join(dir, 'scripts')).sort()).toEqual(
      sources.map((s) => s.replace('scripts/', '')).sort()
    );
    expect(readdirSync(dir).sort()).toEqual(['Dockerfile', 'scripts']);
  });

  it('refuses a symlinked COPY source and a continued COPY line', () => {
    const apiDir = mkdtempSync(join(tmpdir(), 'sam-guided-login-api-'));
    mkdirSync(join(apiDir, 'scripts'));
    writeFileSync(join(apiDir, '.dev.vars'), 'SECRET=1\n');
    symlinkSync(join(apiDir, '.dev.vars'), join(apiDir, 'scripts', 'a.mjs'));
    writeFileSync(join(apiDir, 'Dockerfile.sandbox'), 'FROM x\nCOPY scripts/a.mjs /x\n');
    expect(() =>
      materialiseSandboxImageContext(apiDir, mkdtempSync(join(tmpdir(), 'sam-p-')))
    ).toThrow(/not a regular file/);
    expect(() => dockerfileCopySources('COPY scripts/a.mjs \\\n  /x')).toThrow(/continuation/);
  });

  it('fails on a missing COPY source', () => {
    const apiDir = mkdtempSync(join(tmpdir(), 'sam-guided-login-api-'));
    mkdirSync(join(apiDir, 'scripts'));
    writeFileSync(join(apiDir, 'Dockerfile.sandbox'), 'FROM x\nCOPY scripts/gone.mjs /x\n');
    expect(() =>
      materialiseSandboxImageContext(apiDir, mkdtempSync(join(tmpdir(), 'sam-p-')))
    ).toThrow(/missing/);
  });
});

describe('assertContainerEngineReady', () => {
  const runsc = { runtime: 'runsc', instanceType: 'basic' };
  const runtimes = (names: string[]) =>
    JSON.stringify(Object.fromEntries(names.map((name) => [name, { path: name }])));

  it('passes when the daemon has the runtime', () => {
    expect(() =>
      assertContainerEngineReady(runsc, { ok: true, runtimesJson: runtimes(['runc', 'runsc']) })
    ).not.toThrow();
  });

  it('refuses a daemon without the runtime (the prototype box before `runsc install`)', () => {
    expect(() =>
      assertContainerEngineReady(runsc, { ok: true, runtimesJson: runtimes(['runc']) })
    ).toThrow(/not registered/);
  });

  it('refuses when there is no daemon', () => {
    expect(() =>
      assertContainerEngineReady(runsc, { ok: false, error: 'Cannot connect to the Docker daemon' })
    ).toThrow(/needs a Docker daemon/);
  });
});
