import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

import type { CliConfig, ConfigEnv, ConfigPaths } from './types.js';

const CONFIG_FILE_NAME = 'config.json';
export function resolveConfigPaths(env: ConfigEnv): ConfigPaths {
  if (env.SAM_CONFIG_DIR) {
    return configPathFromDir(env.SAM_CONFIG_DIR);
  }

  if (env.XDG_CONFIG_HOME) {
    return configPathFromDir(path.join(env.XDG_CONFIG_HOME, 'sam'));
  }

  if (env.APPDATA) {
    return configPathFromDir(path.join(env.APPDATA, 'sam'));
  }

  return configPathFromDir(path.join(env.HOME ?? homedir(), '.config', 'sam'));
}

function configPathFromDir(configDir: string): ConfigPaths {
  return {
    configDir,
    configFile: path.join(configDir, CONFIG_FILE_NAME),
  };
}

export function normalizeApiUrl(apiUrl: string): string {
  const parsed = new URL(apiUrl);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('API URL must use http or https');
  }
  parsed.pathname = stripTrailingSlashes(parsed.pathname);
  parsed.search = '';
  parsed.hash = '';
  return stripTrailingSlashes(parsed.toString());
}

function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === '/') {
    end -= 1;
  }
  return value.slice(0, end);
}

export function redactSecret(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '(not set)';
  return '(redacted)';
}

export async function loadConfig(env: ConfigEnv): Promise<CliConfig | null> {
  const envConfig = configFromEnv(env);
  if (envConfig) return envConfig;

  const paths = resolveConfigPaths(env);
  let raw: string;
  try {
    raw = await readFile(paths.configFile, 'utf8');
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }

  const parsed = parseConfig(raw);
  return {
    apiUrl: normalizeApiUrl(parsed.apiUrl),
    sessionCookie: parsed.sessionCookie,
  };
}

export async function saveConfig(env: ConfigEnv, config: CliConfig): Promise<ConfigPaths> {
  const paths = resolveConfigPaths(env);
  await mkdir(paths.configDir, { recursive: true, mode: 0o700 });
  await chmod(paths.configDir, 0o700).catch(() => undefined);
  await writeFile(
    paths.configFile,
    `${JSON.stringify({
      apiUrl: normalizeApiUrl(config.apiUrl),
      sessionCookie: config.sessionCookie,
    }, null, 2)}\n`,
    { mode: 0o600 }
  );
  await chmod(paths.configFile, 0o600).catch(() => undefined);
  return paths;
}

function configFromEnv(env: ConfigEnv): CliConfig | null {
  if (!env.SAM_SESSION_COOKIE) return null;
  if (!env.SAM_API_URL) {
    throw new Error('SAM_API_URL must be set when SAM_SESSION_COOKIE is set');
  }
  return {
    apiUrl: normalizeApiUrl(env.SAM_API_URL),
    sessionCookie: env.SAM_SESSION_COOKIE,
  };
}

function parseConfig(raw: string): CliConfig {
  const parsed: unknown = JSON.parse(raw);
  if (!isConfigShape(parsed)) {
    throw new Error('Invalid SAM CLI config file');
  }
  return parsed;
}

function isConfigShape(value: unknown): value is CliConfig {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.apiUrl === 'string' && typeof candidate.sessionCookie === 'string';
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
