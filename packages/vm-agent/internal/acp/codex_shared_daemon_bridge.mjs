#!/usr/bin/env node

import { createHash, randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline';

const APP_SERVER_SUBCOMMAND = 'app-server';
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_FRAME_BYTES = 16 * 1024 * 1024;
const DEFAULT_PING_INTERVAL_MS = 2_000;
const DEFAULT_PONG_TIMEOUT_MS = 5_000;

function positiveInteger(name, fallback) {
  const value = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function fail(message) {
  process.stderr.write(`SAM Codex shared-daemon bridge: ${message}\n`);
  process.exit(1);
}

const validateOnly = process.argv.length === 3 && process.argv[2] === '--validate';
if (!validateOnly && (process.argv.length !== 3 || process.argv[2] !== APP_SERVER_SUBCOMMAND))
  fail(`expected exactly one ${APP_SERVER_SUBCOMMAND} argument`);

const codexPath = process.env.SAM_CODEX_SHARED_DAEMON_CLI ?? 'codex';
const expectedVersion = process.env.SAM_CODEX_SHARED_DAEMON_EXPECTED_VERSION;
if (!expectedVersion) fail('the pinned Codex version is required');
const cliVersion = spawnSync(codexPath, ['--version'], { env: process.env, encoding: 'utf8' });
if (cliVersion.status !== 0 || cliVersion.stdout.trim() !== `codex-cli ${expectedVersion}`) {
  fail('Codex CLI does not match the pinned version');
}
const socketPath = process.env.SAM_CODEX_SHARED_DAEMON_SOCKET;
if (!socketPath) fail('a dedicated Unix socket is required');
const ownerFile =
  process.env.SAM_CODEX_SHARED_DAEMON_SOCKET_OWNER_FILE ?? `${socketPath}.sam-owner.json`;
try {
  const workspaceRoot = realpathSync(process.cwd());
  const socketParent = realpathSync(dirname(socketPath));
  const relativeParent = relative(workspaceRoot, socketParent);
  if (
    relativeParent === '..' ||
    relativeParent.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
  )
    fail('socket parent escapes the workspace');
  const socketParentInfo = statSync(socketParent);
  const socketLinkInfo = lstatSync(socketPath);
  const realSocketPath = realpathSync(socketPath);
  const relativeSocket = relative(workspaceRoot, realSocketPath);
  if (
    relativeSocket === '..' ||
    relativeSocket.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
  )
    fail('resolved socket escapes the workspace');
  const socketInfo = statSync(realSocketPath);
  const realSocketParentInfo = statSync(dirname(realSocketPath));
  const ownerInfo = lstatSync(ownerFile);
  if (
    (!socketLinkInfo.isSocket() && !socketLinkInfo.isSymbolicLink()) ||
    !socketInfo.isSocket() ||
    !ownerInfo.isFile()
  )
    fail('socket ownership files have invalid types');
  if (
    typeof process.geteuid === 'function' &&
    [socketParentInfo, realSocketParentInfo, socketInfo, ownerInfo].some(
      (info) => info.uid !== process.geteuid()
    )
  )
    fail('socket ownership does not match the runtime user');
  if (
    [socketParentInfo, realSocketParentInfo, socketInfo, ownerInfo].some(
      (info) => (info.mode & 0o077) !== 0
    )
  )
    fail('socket ownership files and directories must be private');
  const marker = JSON.parse(readFileSync(ownerFile, 'utf8'));
  if (
    marker.version !== expectedVersion ||
    resolve(marker.socketPath) !== resolve(socketPath) ||
    resolve(marker.realSocketPath) !== resolve(realSocketPath)
  )
    fail('socket ownership marker does not match the pinned server');
} catch (error) {
  fail(
    error instanceof Error
      ? `socket ownership validation failed: ${error.message}`
      : 'socket ownership validation failed'
  );
}

if (validateOnly) process.exit(0);

const proxyArgs = ['app-server', 'proxy', '--sock', socketPath];
const proxy = spawn(codexPath, proxyArgs, {
  env: process.env,
  stdio: ['pipe', 'pipe', 'ignore'],
});

let handshakeComplete = false;
let incoming = Buffer.alloc(0);
let fragmented = Buffer.alloc(0);
let fragmentOpcode = 0;
let pingSentAt = 0;
const queuedMessages = [];
let queuedBytes = 0;
const maxFrameBytes = positiveInteger(
  'SAM_CODEX_SHARED_DAEMON_MAX_FRAME_BYTES',
  DEFAULT_MAX_FRAME_BYTES
);

function encodeClientFrame(opcode, payload = Buffer.alloc(0)) {
  if (!Buffer.isBuffer(payload)) payload = Buffer.from(payload);
  if (payload.length > maxFrameBytes) fail('outbound frame exceeds configured maximum');
  const mask = randomBytes(4);
  let header;
  if (payload.length < 126) {
    header = Buffer.alloc(2);
    header[1] = 0x80 | payload.length;
  } else if (payload.length <= 0xffff) {
    header = Buffer.alloc(4);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  header[0] = 0x80 | opcode;
  const masked = Buffer.allocUnsafe(payload.length);
  for (let i = 0; i < payload.length; i += 1) masked[i] = payload[i] ^ mask[i % 4];
  return Buffer.concat([header, mask, masked]);
}

function sendFrame(opcode, payload) {
  if (proxy.stdin.destroyed || proxy.stdin.writableEnded || proxy.stdin.writableFinished) return;
  try {
    proxy.stdin.write(encodeClientFrame(opcode, payload));
  } catch (error) {
    if (error?.code !== 'EPIPE' && error?.code !== 'ERR_STREAM_WRITE_AFTER_END') throw error;
  }
}

function emitMessage(payload) {
  if (payload.length > maxFrameBytes) fail('inbound message exceeds configured maximum');
  process.stdout.write(payload);
  if (payload.length === 0 || payload[payload.length - 1] !== 0x0a) process.stdout.write('\n');
}

function readFrameLength(second) {
  const marker = second & 0x7f;
  if (marker < 126) return { payloadLength: marker, offset: 2 };
  if (marker === 126) {
    if (incoming.length < 4) return undefined;
    return { payloadLength: incoming.readUInt16BE(2), offset: 4 };
  }
  if (incoming.length < 10) return undefined;
  const length = incoming.readBigUInt64BE(2);
  if (length > BigInt(maxFrameBytes)) fail('inbound frame exceeds configured maximum');
  return { payloadLength: Number(length), offset: 10 };
}

function parseFrame() {
  if (incoming.length < 2) return undefined;
  const first = incoming[0];
  const second = incoming[1];
  if ((first & 0x70) !== 0) fail('websocket frame used unsupported RSV bits');
  if ((second & 0x80) !== 0) fail('server websocket frames must not be masked');

  const length = readFrameLength(second);
  if (length === undefined) return undefined;
  const { payloadLength, offset } = length;
  if (payloadLength > maxFrameBytes) fail('inbound frame exceeds configured maximum');
  if (incoming.length < offset + payloadLength) return undefined;

  const fin = (first & 0x80) !== 0;
  const opcode = first & 0x0f;
  if (opcode >= 0x8 && (!fin || payloadLength > 125)) fail('invalid websocket control frame');
  const payload = incoming.subarray(offset, offset + payloadLength);
  incoming = incoming.subarray(offset + payloadLength);
  return { fin, opcode, payload };
}

function handleContinuation({ fin, payload }) {
  if (fragmentOpcode === 0) fail('unexpected continuation frame');
  fragmented = Buffer.concat([fragmented, payload]);
  if (fragmented.length > maxFrameBytes) fail('fragmented message exceeds configured maximum');
  if (!fin) return;
  if (fragmentOpcode === 0x1) emitMessage(fragmented);
  fragmented = Buffer.alloc(0);
  fragmentOpcode = 0;
}

function handleFrame(frame) {
  if (frame.opcode === 0x8) {
    sendFrame(0x8, frame.payload);
    proxy.stdin.end();
    return false;
  }
  if (frame.opcode === 0x9) sendFrame(0xa, frame.payload);
  else if (frame.opcode === 0xa) pingSentAt = 0;
  else if (frame.opcode === 0x0) handleContinuation(frame);
  else if (frame.opcode === 0x1 || frame.opcode === 0x2) {
    if (!frame.fin) {
      fragmented = Buffer.from(frame.payload);
      fragmentOpcode = frame.opcode;
    } else if (frame.opcode === 0x1) emitMessage(frame.payload);
  } else fail('unsupported websocket opcode');
  return true;
}

function consumeFrames() {
  let frame = parseFrame();
  while (frame !== undefined) {
    if (!handleFrame(frame)) return;
    frame = parseFrame();
  }
}

const handshakeKey = randomBytes(16).toString('base64');
// RFC 6455 section 4.2.2 mandates SHA-1 for Sec-WebSocket-Accept; this is not a password hash.
const expectedAccept = createHash('sha1') // NOSONAR
  .update(`${handshakeKey}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
  .digest('base64');
proxy.stdin.write(
  [
    'GET / HTTP/1.1',
    'Host: localhost',
    'Connection: Upgrade',
    'Upgrade: websocket',
    `Sec-WebSocket-Key: ${handshakeKey}`,
    'Sec-WebSocket-Version: 13',
    '',
    '',
  ].join('\r\n')
);

const handshakeTimer = setTimeout(
  () => fail('websocket handshake timed out'),
  positiveInteger('SAM_CODEX_SHARED_DAEMON_HANDSHAKE_TIMEOUT_MS', DEFAULT_HANDSHAKE_TIMEOUT_MS)
);
handshakeTimer.unref();

proxy.stdout.on('data', (chunk) => {
  incoming = Buffer.concat([incoming, chunk]);
  if (!handshakeComplete) {
    const boundary = incoming.indexOf('\r\n\r\n');
    if (boundary < 0) {
      if (incoming.length > maxFrameBytes)
        fail('websocket handshake headers exceed configured maximum');
      return;
    }
    const response = incoming.subarray(0, boundary).toString('utf8');
    const responseLines = response.split('\r\n');
    const [protocol, status] = responseLines[0].split(' ');
    if ((protocol !== 'HTTP/1.0' && protocol !== 'HTTP/1.1') || status !== '101')
      fail('websocket upgrade was rejected');
    const acceptLine = responseLines.find((line) =>
      line.toLowerCase().startsWith('sec-websocket-accept:')
    );
    const accept = acceptLine?.slice(acceptLine.indexOf(':') + 1).trim();
    if (accept !== expectedAccept) fail('websocket upgrade returned an invalid accept key');
    incoming = incoming.subarray(boundary + 4);
    handshakeComplete = true;
    pingSentAt = 0;
    clearTimeout(handshakeTimer);
    for (const message of queuedMessages.splice(0)) sendFrame(0x1, message);
    queuedBytes = 0;
  }
  consumeFrames();
});

const pingIntervalMs = positiveInteger(
  'SAM_CODEX_SHARED_DAEMON_PING_INTERVAL_MS',
  DEFAULT_PING_INTERVAL_MS
);
const pongTimeoutMs = positiveInteger(
  'SAM_CODEX_SHARED_DAEMON_PONG_TIMEOUT_MS',
  DEFAULT_PONG_TIMEOUT_MS
);
const heartbeat = setInterval(() => {
  if (!handshakeComplete) return;
  if (pingSentAt !== 0 && Date.now() - pingSentAt > pongTimeoutMs)
    fail('websocket heartbeat timed out');
  if (pingSentAt !== 0) return;
  pingSentAt = Date.now();
  sendFrame(0x9, Buffer.from(String(Date.now())));
}, pingIntervalMs);
heartbeat.unref();

createInterface({ input: process.stdin }).on('line', (line) => {
  if (line.trim() === '') return;
  const payload = Buffer.from(line, 'utf8');
  if (handshakeComplete) sendFrame(0x1, payload);
  else {
    queuedBytes += payload.length;
    if (queuedBytes > maxFrameBytes) fail('queued messages exceed configured maximum');
    queuedMessages.push(payload);
  }
});

process.stdin.on('end', () => {
  if (handshakeComplete) sendFrame(0x8);
  if (!proxy.stdin.destroyed && !proxy.stdin.writableEnded) proxy.stdin.end();
});

proxy.on('error', () => fail('could not start app-server proxy'));
proxy.stdin.on('error', (error) => {
  if (error?.code !== 'EPIPE' && error?.code !== 'ERR_STREAM_WRITE_AFTER_END') {
    fail('app-server proxy input failed');
  }
});
proxy.on('exit', (code, signal) => {
  if (code !== 0 && signal == null) fail('app-server proxy exited unexpectedly');
  process.exit(code ?? 0);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (handshakeComplete) sendFrame(0x8);
    proxy.kill(signal);
  });
}
