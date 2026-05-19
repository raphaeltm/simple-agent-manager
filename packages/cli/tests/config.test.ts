import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { loadConfig, redactSecret, resolveConfigPaths, saveConfig } from '../src/config.js';

describe('config', () => {
  it('stores config with restrictive file permissions', async () => {
    const configDir = await mkdtemp(path.join(tmpdir(), 'sam-cli-test-'));
    const paths = await saveConfig(
      { SAM_CONFIG_DIR: configDir },
      {
        apiUrl: 'https://api.sammy.party/',
        sessionCookie: 'better-auth.session_token=secret',
      }
    );

    const raw = await readFile(paths.configFile, 'utf8');
    const fileStat = await stat(paths.configFile);
    const loaded = await loadConfig({ SAM_CONFIG_DIR: configDir });

    expect(raw).toContain('https://api.sammy.party');
    expect(raw).toContain('better-auth.session_token=secret');
    expect(fileStat.mode & 0o777).toBe(0o600);
    expect(loaded).toEqual({
      apiUrl: 'https://api.sammy.party',
      sessionCookie: 'better-auth.session_token=secret',
    });
  });

  it('uses environment config only when both values are present', async () => {
    await expect(loadConfig({ SAM_API_URL: 'https://api.sammy.party' })).rejects.toThrow(
      'SAM_API_URL and SAM_SESSION_COOKIE must be set together'
    );

    await expect(loadConfig({
      SAM_API_URL: 'https://api.sammy.party',
      SAM_SESSION_COOKIE: 'cookie=value',
    })).resolves.toEqual({
      apiUrl: 'https://api.sammy.party',
      sessionCookie: 'cookie=value',
    });
  });

  it('resolves config paths from XDG config home', () => {
    expect(resolveConfigPaths({ XDG_CONFIG_HOME: '/tmp/config' })).toEqual({
      configDir: '/tmp/config/sam',
      configFile: '/tmp/config/sam/config.json',
    });
  });

  it('redacts all but the suffix of secrets', () => {
    expect(redactSecret('better-auth.session_token=abcdef')).toBe('redacted:abcdef');
    expect(redactSecret('')).toBe('(not set)');
  });
});
