import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
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

  it('accepts an explicit runtime, and "default" for the daemon default', () => {
    expect(
      guidedLoginSettings({ SAM_GUIDED_LOGIN: 'on', SAM_GUIDED_LOGIN_RUNTIME: 'kata' })?.runtime
    ).toBe('kata');
    expect(
      guidedLoginSettings({ SAM_GUIDED_LOGIN: 'on', SAM_GUIDED_LOGIN_RUNTIME: 'default' })?.runtime
    ).toBeNull();
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

  it('fails on a missing COPY source', () => {
    const apiDir = mkdtempSync(join(tmpdir(), 'sam-guided-login-api-'));
    mkdirSync(join(apiDir, 'scripts'));
    writeFileSync(join(apiDir, 'Dockerfile.sandbox'), 'FROM x\nCOPY scripts/gone.mjs /x\n');
    expect(() =>
      materialiseSandboxImageContext(apiDir, mkdtempSync(join(tmpdir(), 'sam-p-')))
    ).toThrow(/missing/);
  });
});
