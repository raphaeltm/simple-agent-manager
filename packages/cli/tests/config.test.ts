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
        apiUrl: 'https://api.example.com/',
        sessionCookie: 'better-auth.session_token=secret',
      }
    );

    const raw = await readFile(paths.configFile, 'utf8');
    const fileStat = await stat(paths.configFile);
    const loaded = await loadConfig({ SAM_CONFIG_DIR: configDir });

    expect(raw).toContain('https://api.example.com');
    expect(raw).toContain('better-auth.session_token=secret');
    expect(fileStat.mode & 0o777).toBe(0o600);
    expect(loaded).toEqual({
      apiUrl: 'https://api.example.com',
      sessionCookie: 'better-auth.session_token=secret',
    });
  });

  it('uses environment config only when a session cookie and API URL are present', async () => {
    await expect(loadConfig({ SAM_API_URL: 'https://api.example.com' })).resolves.toBeNull();
    await expect(loadConfig({ SAM_SESSION_COOKIE: 'cookie=value' })).rejects.toThrow(
      'SAM_API_URL must be set when SAM_SESSION_COOKIE is set'
    );

    await expect(loadConfig({
      SAM_API_URL: 'https://api.example.com',
      SAM_SESSION_COOKIE: 'cookie=value',
    })).resolves.toEqual({
      apiUrl: 'https://api.example.com',
      sessionCookie: 'cookie=value',
    });
  });

  it('resolves config paths from XDG config home', async () => {
    const configHome = await mkdtemp(path.join(tmpdir(), 'sam-cli-xdg-'));

    expect(resolveConfigPaths({ XDG_CONFIG_HOME: configHome })).toEqual({
      configDir: path.join(configHome, 'sam'),
      configFile: path.join(configHome, 'sam', 'config.json'),
    });
  });

  it('redacts secrets without exposing token fragments', () => {
    expect(redactSecret('better-auth.session_token=abcdef')).toBe('(redacted)');
    expect(redactSecret('')).toBe('(not set)');
  });
});
