#!/usr/bin/env node

/**
 * THROWAWAY PROTOTYPE — Buzz ↔ SAM ACP bridge.
 *
 * This file deliberately proves one narrow thing: Buzz can spawn an ACP process
 * whose turns run in a remote SAM conversation. It is not the production
 * `sam acp` design. Full context: SAM idea 01KZPTT49W10FC1P9G9RQEK8M1.
 *
 * Intentional shortcuts that a real implementation MUST replace:
 * - Turn completion is inferred from persisted messages plus a quiet window.
 *   Production needs a robust, explicit turn-boundary contract.
 * - Buzz ACP session bindings live only in this process. Production needs a
 *   durable channel → SAM session binding.
 * - There is no resume/rebind path. Production needs runtime-neutral dormant
 *   resume that restores harness-native files and git WIP, not just chat text.
 * - A fork is not attempted here. Production should fork only for deliberate
 *   branching or as an honest degradation fallback when exact resume fails.
 * - No VM/cf-container error taxonomy is guessed. A dead session fails loudly.
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const PROTOCOL_VERSION = 2;
const DEFAULT_POLL_MS = 1_000;
const DEFAULT_SETTLE_MS = 2_500;
const DEFAULT_TURN_TIMEOUT_MS = 30 * 60 * 1_000;
const DEFAULT_HTTP_TIMEOUT_MS = 30_000;
const DEFAULT_KEEPALIVE_MS = 10_000;
const DEFAULT_TASK_CHECK_MS = 5_000;
const DEFAULT_MESSAGE_LIMIT = 500;
const DEFAULT_ERROR_BODY_LIMIT = 1_000;
const DEFAULT_BUZZ_STDERR_LIMIT = 4_000;
const ERROR_INVALID_REQUEST = -32600;
const ERROR_METHOD_NOT_FOUND = -32601;
const ERROR_INVALID_PARAMS = -32602;
const ERROR_INTERNAL = -32000;
const TERMINAL_TASK_STATUSES = new Set(['cancelled', 'completed', 'failed']);

class RpcError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

class SamApiError extends Error {
  constructor(status, code, message) {
    super(`SAM API ${status} ${code}: ${message}`);
    this.status = status;
    this.code = code;
  }
}

function safeDiagnostic(value, limit) {
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

async function loadConfiguration() {
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

  const apiUrl = (envApiUrl || cliConfig.apiUrl || '').replace(/\/+$/, '');
  const sessionCookie = envCookie || cliConfig.sessionCookie || '';
  if (!apiUrl || !sessionCookie) {
    throw new Error('SAM auth config is missing apiUrl or sessionCookie; run `sam auth login`');
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
  };
}

function projectPath(projectId, ...segments) {
  const encoded = [projectId, ...segments].map((part) => encodeURIComponent(part));
  return `/api/projects/${encoded.join('/')}`;
}

class SamApi {
  constructor(config) {
    this.config = config;
  }

  async request(path, options = {}) {
    const response = await fetch(`${this.config.apiUrl}${path}`, {
      method: options.method ?? 'GET',
      headers: {
        Accept: 'application/json',
        Cookie: this.config.sessionCookie,
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: AbortSignal.timeout(this.config.httpTimeoutMs),
    });

    const text = await response.text();
    let payload = {};
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = { message: safeDiagnostic(text, this.config.errorBodyLimit) };
      }
    }
    if (!response.ok) {
      throw new SamApiError(
        response.status,
        typeof payload.error === 'string' ? payload.error : 'HTTP_ERROR',
        safeDiagnostic(
          typeof payload.message === 'string' ? payload.message : response.statusText,
          this.config.errorBodyLimit
        )
      );
    }
    return payload;
  }

  submitConversation(message) {
    return this.request(projectPath(this.config.projectId, 'tasks', 'submit'), {
      method: 'POST',
      body: {
        message,
        taskMode: 'conversation',
        agentProfileId: this.config.agentProfileId,
      },
    });
  }

  sendPrompt(sessionId, content) {
    return this.request(projectPath(this.config.projectId, 'sessions', sessionId, 'prompt'), {
      method: 'POST',
      body: { content },
    });
  }

  cancel(sessionId) {
    return this.request(projectPath(this.config.projectId, 'sessions', sessionId, 'cancel'), {
      method: 'POST',
    });
  }

  getState(sessionId) {
    return this.request(projectPath(this.config.projectId, 'sessions', sessionId, 'state'));
  }

  getAssistantMessages(sessionId) {
    const query = new URLSearchParams({
      roles: 'assistant',
      limit: String(this.config.messageLimit),
      compact: 'false',
      order: 'desc',
    });
    return this.request(
      `${projectPath(this.config.projectId, 'sessions', sessionId, 'messages')}?${query}`
    );
  }

  getTask(taskId) {
    return this.request(projectPath(this.config.projectId, 'tasks', taskId));
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function promptText(params) {
  if (!params || typeof params !== 'object') {
    throw new RpcError(ERROR_INVALID_PARAMS, 'session/prompt params are required');
  }
  const blocks = Array.isArray(params.prompt) ? params.prompt : [];
  const text = blocks
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
  if (!text.trim()) {
    throw new RpcError(ERROR_INVALID_PARAMS, 'session/prompt requires at least one text block');
  }
  return text;
}

function parseBuzzTarget(text) {
  const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
  const channelIds = new Set();
  for (const pattern of [
    new RegExp(`^\\s*Channel:\\s+.*\\(#(${uuid})\\)\\s*$`, 'gim'),
    new RegExp(`^\\s*Channel:\\s+#?(${uuid})\\s*$`, 'gim'),
  ]) {
    for (const match of text.matchAll(pattern)) channelIds.add(match[1].toLowerCase());
  }
  if (channelIds.size === 0) {
    throw new Error('Buzz prompt did not contain a recognizable channel UUID');
  }
  if (channelIds.size > 1) {
    throw new Error('Buzz prompt contained conflicting channel UUIDs');
  }

  const replyIds = new Set(
    [...text.matchAll(/--reply-to\s+([0-9a-f]{64})\b/gi)].map((match) => match[1].toLowerCase())
  );
  if (replyIds.size > 1) throw new Error('Buzz prompt contained conflicting reply targets');

  return {
    channelId: [...channelIds][0],
    replyTo: replyIds.size === 1 ? [...replyIds][0] : null,
  };
}

function samPrompt(original) {
  return `${original}\n\n[SAM Buzz ACP prototype transport]\nReturn the reply as your final assistant text. Do not run the local \`buzz\` CLI: this bridge will publish the final text from the Buzz machine, and the Buzz identity is intentionally not available in the remote SAM workspace.`;
}

async function postToBuzz(config, target, content) {
  // PROTOTYPE SHORTCUT: the reply-only posture keeps the Buzz identity on this
  // machine. A product version needs an explicit capability/trust design before
  // it can delegate Buzz tools or identity to a remote workspace.
  const args = ['messages', 'send', '--channel', target.channelId, '--content', '-'];
  if (target.replyTo) args.push('--reply-to', target.replyTo);

  await new Promise((resolve, reject) => {
    const childEnv = { ...process.env };
    for (const name of [
      'SAM_SESSION_COOKIE',
      'SAM_API_TOKEN',
      'SAM_MCP_TOKEN',
      'GH_TOKEN',
      'GITHUB_TOKEN',
    ]) {
      delete childEnv[name];
    }
    const child = spawn(config.buzzCli, args, {
      env: childEnv,
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-config.buzzStderrLimit);
    });
    child.on('error', (error) =>
      reject(
        new Error(
          `failed to start Buzz CLI: ${safeDiagnostic(error.message, config.buzzStderrLimit)}`
        )
      )
    );
    child.on('close', (code) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(
            `Buzz CLI exited ${code}: ${safeDiagnostic(stderr.trim(), config.buzzStderrLimit) || 'no error detail'}`
          )
        );
    });
    child.stdin.end(content);
  });
}

class AcpBridge {
  constructor(config, api, write) {
    this.config = config;
    this.api = api;
    this.write = write;
    this.sessions = new Map();
  }

  response(id, result) {
    this.write({ jsonrpc: '2.0', id, result });
  }

  error(id, code, message) {
    this.write({ jsonrpc: '2.0', id, error: { code, message } });
  }

  update(localSessionId, update) {
    this.write({
      jsonrpc: '2.0',
      method: 'session/update',
      params: { sessionId: localSessionId, update },
    });
  }

  async receive(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.error(null, -32700, 'invalid JSON');
      return;
    }
    if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      this.error(message?.id ?? null, ERROR_INVALID_REQUEST, 'invalid JSON-RPC request');
      return;
    }

    try {
      switch (message.method) {
        case 'initialize':
          this.initialize(message.id, message.params);
          break;
        case 'session/new':
          this.newSession(message.id);
          break;
        case 'session/prompt':
          await this.prompt(message.id, message.params);
          break;
        case 'session/cancel':
          await this.cancel(message.params);
          break;
        default:
          if (message.id !== undefined) {
            throw new RpcError(ERROR_METHOD_NOT_FOUND, `unsupported ACP method: ${message.method}`);
          }
      }
    } catch (error) {
      if (message.id === undefined) {
        console.error(
          `ACP notification failed: ${safeDiagnostic(error.message, this.config.errorBodyLimit)}`
        );
        return;
      }
      this.error(
        message.id,
        error instanceof RpcError ? error.code : ERROR_INTERNAL,
        safeDiagnostic(error.message || String(error), this.config.errorBodyLimit)
      );
    }
  }

  initialize(id, params) {
    if (id === undefined) throw new RpcError(ERROR_INVALID_REQUEST, 'initialize must be a request');
    const requested = Number.isFinite(params?.protocolVersion) ? params.protocolVersion : 1;
    this.response(id, {
      protocolVersion: Math.min(requested, PROTOCOL_VERSION),
      agentCapabilities: {
        loadSession: false,
        promptCapabilities: { image: false, audio: false, embeddedContext: false },
        mcpCapabilities: { http: false, sse: false },
      },
      agentInfo: { name: 'sam-acp-prototype', version: '0.0.0-experimental' },
    });
  }

  newSession(id) {
    if (id === undefined)
      throw new RpcError(ERROR_INVALID_REQUEST, 'session/new must be a request');
    const localSessionId = `sam-prototype-${randomUUID()}`;

    // PROTOTYPE SHORTCUT: Buzz's cwd, MCP servers, and session metadata are not
    // mapped into the remote workspace, and this binding is process-memory only.
    // A real implementation needs durable per-channel binding plus a deliberate
    // remote-workspace contract; it must not pretend this supports session/load.
    this.sessions.set(localSessionId, {
      localSessionId,
      samSessionId: null,
      taskId: null,
      buzzChannelId: null,
      inFlight: null,
    });
    this.response(id, { sessionId: localSessionId });
  }

  getSession(params) {
    const localSessionId = params?.sessionId;
    if (typeof localSessionId !== 'string') {
      throw new RpcError(ERROR_INVALID_PARAMS, 'sessionId is required');
    }
    const session = this.sessions.get(localSessionId);
    if (!session) throw new RpcError(ERROR_INVALID_PARAMS, `unknown session: ${localSessionId}`);
    return session;
  }

  async prompt(id, params) {
    if (id === undefined)
      throw new RpcError(ERROR_INVALID_REQUEST, 'session/prompt must be a request');
    const session = this.getSession(params);
    if (session.inFlight) {
      throw new RpcError(ERROR_INVALID_REQUEST, 'a prompt is already in flight for this session');
    }

    const originalPrompt = promptText(params);
    const target = parseBuzzTarget(originalPrompt);
    if (session.buzzChannelId && session.buzzChannelId !== target.channelId) {
      throw new RpcError(
        ERROR_INVALID_PARAMS,
        `this prototype ACP session is already bound to Buzz channel ${session.buzzChannelId}`
      );
    }
    session.buzzChannelId ??= target.channelId;
    const turn = { cancelRequested: false, cancelPromise: null };
    session.inFlight = turn;

    try {
      let baseline = new Set();
      if (session.samSessionId) {
        const existing = await this.api.getAssistantMessages(session.samSessionId);
        baseline = new Set((existing.messages ?? []).map((message) => message.id));
        await this.api.sendPrompt(session.samSessionId, samPrompt(originalPrompt));
      } else {
        const submitted = await this.api.submitConversation(samPrompt(originalPrompt));
        if (!submitted.sessionId || !submitted.taskId) {
          throw new Error('SAM task submission response omitted sessionId or taskId');
        }
        session.samSessionId = submitted.sessionId;
        session.taskId = submitted.taskId;
      }

      if (turn.cancelRequested) await this.requestCancel(session, turn);
      const result = await this.pollTurn(session, turn, baseline);
      if (result.stopReason === 'end_turn') {
        await postToBuzz(this.config, target, result.text);
      }
      this.response(id, { stopReason: result.stopReason });
    } finally {
      session.inFlight = null;
    }
  }

  async cancel(params) {
    const session = this.getSession(params);
    if (!session.inFlight) return;
    session.inFlight.cancelRequested = true;
    if (session.samSessionId) await this.requestCancel(session, session.inFlight);
  }

  async requestCancel(session, turn) {
    if (!turn.cancelPromise) {
      turn.cancelPromise = this.api.cancel(session.samSessionId);
    }
    await turn.cancelPromise;
  }

  async pollTurn(session, turn, baseline) {
    // PROTOTYPE SHORTCUT: persisted token rows and a quiet window are not an
    // authoritative turn boundary. Production needs an explicit completion
    // event that is durable across API/runtime reconnects. This heuristic is
    // intentionally bounded and fails instead of silently rebinding or forking.
    const startedAt = Date.now();
    const seen = new Set(baseline);
    const chunks = [];
    let sawBusy = false;
    let idleSince = null;
    let lastChunkAt = null;
    let lastKeepaliveAt = 0;
    let lastTaskCheckAt = 0;

    while (Date.now() - startedAt < this.config.turnTimeoutMs) {
      if (turn.cancelRequested) {
        await this.requestCancel(session, turn);
        return { stopReason: 'cancelled', text: '' };
      }

      const now = Date.now();
      const [stateResponse, messagesResponse] = await Promise.all([
        this.api.getState(session.samSessionId),
        this.api.getAssistantMessages(session.samSessionId),
      ]);

      if (now - lastTaskCheckAt >= this.config.taskCheckMs && session.taskId) {
        const task = await this.api.getTask(session.taskId);
        if (TERMINAL_TASK_STATUSES.has(task.status)) {
          throw new Error(
            `SAM task became ${task.status}: ${task.errorMessage || 'the conversation is no longer live'}`
          );
        }
        lastTaskCheckAt = now;
      }

      const state = stateResponse.state ?? null;
      if (state?.activity === 'error' || state?.activity === 'stopped') {
        throw new Error(
          `SAM session became ${state.activity}: ${state.statusError || state.lastStopReason || 'no detail'}`
        );
      }
      if (state?.activity === 'prompting' || state?.activity === 'recovering') sawBusy = true;

      for (const message of messagesResponse.messages ?? []) {
        if (!message?.id || seen.has(message.id)) continue;
        seen.add(message.id);
        if (typeof message.content !== 'string' || message.content.length === 0) continue;
        chunks.push(message.content);
        lastChunkAt = Date.now();
        this.update(session.localSessionId, {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: message.content },
        });
      }

      const idleAfterBusy = sawBusy && state?.activity === 'idle';
      if (idleAfterBusy) idleSince ??= Date.now();
      else idleSince = null;

      const outputIsQuiet = lastChunkAt && Date.now() - lastChunkAt >= this.config.settleMs;
      const stateNeverWentBusy = !sawBusy && (!state || state.activity === 'idle');
      if (chunks.length > 0 && outputIsQuiet && (idleAfterBusy || stateNeverWentBusy)) {
        const text = chunks.join('').trim();
        if (!text) throw new Error('SAM turn ended without non-empty assistant output');
        return { stopReason: 'end_turn', text };
      }
      if (idleSince && !chunks.length && Date.now() - idleSince >= this.config.settleMs) {
        throw new Error('SAM turn ended without persisted assistant output');
      }

      if (Date.now() - lastKeepaliveAt >= this.config.keepaliveMs) {
        this.update(session.localSessionId, { sessionUpdate: 'keepalive' });
        lastKeepaliveAt = Date.now();
      }
      await sleep(this.config.pollMs);
    }

    throw new Error(
      `SAM turn did not reach an honest completion boundary within ${this.config.turnTimeoutMs}ms`
    );
  }
}

async function main() {
  const config = await loadConfiguration();
  const write = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
  const bridge = new AcpBridge(config, new SamApi(config), write);
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on('line', (line) => {
    if (!line.trim()) return;
    void bridge.receive(line).catch((error) => {
      console.error(
        `unhandled ACP bridge error: ${safeDiagnostic(error.stack || error, config.errorBodyLimit)}`
      );
    });
  });
}

main().catch((error) => {
  console.error(
    `SAM ACP prototype failed to start: ${safeDiagnostic(error.message, DEFAULT_ERROR_BODY_LIMIT)}`
  );
  process.exitCode = 1;
});
