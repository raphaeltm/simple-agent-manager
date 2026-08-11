import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_POLL_MS = 1_000;
const DEFAULT_SETTLE_MS = 2_500;
const DEFAULT_TURN_TIMEOUT_MS = 30 * 60 * 1_000;
const DEFAULT_HTTP_TIMEOUT_MS = 30_000;
const DEFAULT_KEEPALIVE_MS = 10_000;
const DEFAULT_TASK_CHECK_MS = 5_000;
const DEFAULT_MESSAGE_LIMIT = 500;
export const DEFAULT_ERROR_BODY_LIMIT = 1_000;
const DEFAULT_BUZZ_STDERR_LIMIT = 4_000;
const DEFAULT_BUZZ_TIMEOUT_MS = 30_000;

export function safeDiagnostic(value, limit) {
  return String(value ?? '')
    .replace(/((?:authorization|cookie|password|secret|token)\s*[=:]\s*)[^\s,;]+/gi, '$1[redacted]')
    .slice(0, limit);
}

function envText(name) {
  return process.env[name]?.trim() ?? '';
}

function positiveInteger(name, fallback) {
  const raw = envText(name);
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function resolveConfigFile() {
  const explicit = envText('SAM_CONFIG_DIR');
  if (explicit) return join(explicit, 'config.json');
  const xdg = envText('XDG_CONFIG_HOME');
  if (xdg) return join(xdg, 'sam', 'config.json');
  return join(homedir(), '.config', 'sam', 'config.json');
}

export function validateApiUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('SAM API URL must be a valid absolute URL');
  }
  if (url.username || url.password) {
    throw new Error('SAM API URL must not contain embedded credentials');
  }
  if (url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new Error('SAM API URL must be an origin without a path, query, or fragment');
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('SAM API URL must use HTTPS (HTTP is allowed only for a loopback test server)');
  }
  return url.origin;
}

export async function loadConfiguration() {
  const envApiUrl = envText('SAM_API_URL');
  const envCookie = envText('SAM_SESSION_COOKIE');
  let cliConfig = {};

  if (envApiUrl || envCookie) {
    if (!envApiUrl || !envCookie) {
      throw new Error('SAM_API_URL and SAM_SESSION_COOKIE must be set together');
    }
  } else {
    const configFile = resolveConfigFile();
    let raw;
    try {
      raw = await readFile(configFile, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') {
        throw new Error(`SAM auth config not found at ${configFile}; run \`sam auth login\` first`);
      }
      throw error;
    }
    try {
      cliConfig = JSON.parse(raw);
    } catch (error) {
      throw new Error(`failed to parse SAM auth config: ${error.message}`);
    }
  }

  const apiUrl = validateApiUrl(envApiUrl || cliConfig.apiUrl || '');
  const sessionCookie = envCookie || cliConfig.sessionCookie || '';
  if (!sessionCookie) {
    throw new Error('SAM auth config is missing sessionCookie; run `sam auth login`');
  }

  const projectId = envText('SAM_PROJECT_ID');
  const agentProfileId = envText('SAM_AGENT_PROFILE_ID');
  if (!projectId || !agentProfileId) {
    throw new Error('SAM_PROJECT_ID and SAM_AGENT_PROFILE_ID are required');
  }

  return {
    apiUrl,
    sessionCookie,
    projectId,
    agentProfileId,
    buzzCli: envText('BUZZ_CLI') || 'buzz',
    pollMs: positiveInteger('SAM_ACP_POLL_MS', DEFAULT_POLL_MS),
    settleMs: positiveInteger('SAM_ACP_SETTLE_MS', DEFAULT_SETTLE_MS),
    turnTimeoutMs: positiveInteger('SAM_ACP_TURN_TIMEOUT_MS', DEFAULT_TURN_TIMEOUT_MS),
    httpTimeoutMs: positiveInteger('SAM_ACP_HTTP_TIMEOUT_MS', DEFAULT_HTTP_TIMEOUT_MS),
    keepaliveMs: positiveInteger('SAM_ACP_KEEPALIVE_MS', DEFAULT_KEEPALIVE_MS),
    taskCheckMs: positiveInteger('SAM_ACP_TASK_CHECK_MS', DEFAULT_TASK_CHECK_MS),
    messageLimit: positiveInteger('SAM_ACP_MESSAGE_LIMIT', DEFAULT_MESSAGE_LIMIT),
    errorBodyLimit: positiveInteger('SAM_ACP_ERROR_BODY_LIMIT', DEFAULT_ERROR_BODY_LIMIT),
    buzzStderrLimit: positiveInteger('SAM_ACP_BUZZ_STDERR_LIMIT', DEFAULT_BUZZ_STDERR_LIMIT),
    buzzTimeoutMs: positiveInteger('SAM_ACP_BUZZ_TIMEOUT_MS', DEFAULT_BUZZ_TIMEOUT_MS),
  };
}
