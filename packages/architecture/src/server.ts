import { realpath } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import path from 'node:path';

import {
  DEFAULT_SERVER_HOST,
  DEFAULT_SERVER_PORT,
  DEFAULT_SERVER_SOURCE_BYTES,
} from './constants';
import { hasErrors } from './diagnostics';
import { PathSafetyError } from './path-safety';
import { getWorkspaceSummary } from './queries';
import { EventHub } from './server/events';
import { HttpError, readJsonBody, requireMethod, sendError, sendJson } from './server/http';
import { makeElementDetails, makeViewerModel, sourceRefsForTarget } from './server/payloads';
import { serveViewerAsset } from './server/static-assets';
import {
  createThreadRequestSchema,
  replyRequestSchema,
  sourcePreviewRequestSchema,
} from './server/validation';
import { WorkspaceState } from './server/workspace-state';
import { readSourceReference } from './source';
import { appendThreadReply, createThread } from './threads';
import type { LoadWorkspaceOptions } from './types';

export interface ArchitectureServerOptions extends LoadWorkspaceOptions {
  host?: string;
  port?: number;
  allowNonLoopback?: boolean;
  maxSourceBytes?: number;
  watchIntervalMs?: number;
}

export interface RunningArchitectureServer {
  url: string;
  server: Server;
  close: () => Promise<void>;
}

export async function startArchitectureServer(
  options: ArchitectureServerOptions = {}
): Promise<RunningArchitectureServer> {
  const host = options.host ?? DEFAULT_SERVER_HOST;
  if (!options.allowNonLoopback && !isLoopbackHost(host)) {
    throw new PathSafetyError(`Refusing non-loopback architecture server host: ${host}`);
  }
  const events = new EventHub();
  const state = new WorkspaceState(options, events);
  await state.start();
  const server = createServer((request, response) => {
    void routeRequest(request, response, state, events, options);
  });
  const port = options.port ?? DEFAULT_SERVER_PORT;
  await listen(server, port, host);
  return {
    url: `http://${host}:${addressPort(server)}`,
    server,
    close: async () => {
      await state.stop();
      events.close();
      await closeServer(server);
    },
  };
}

async function routeRequest(
  request: IncomingMessage,
  response: ServerResponse,
  state: WorkspaceState,
  events: EventHub,
  options: ArchitectureServerOptions
): Promise<void> {
  try {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? DEFAULT_SERVER_HOST}`);
    if (url.pathname === '/health') return handleHealth(request, response, state);
    if (url.pathname === '/api/model') return handleModel(request, response, state);
    if (url.pathname === '/api/summary') return handleSummary(request, response, state);
    if (url.pathname.startsWith('/api/elements/')) return handleElement(request, response, state, url);
    if (url.pathname === '/api/source-preview') return await handleSource(request, response, state, options);
    if (url.pathname === '/api/threads') return await handleCreateThread(request, response, state);
    if (url.pathname.startsWith('/api/threads/') && url.pathname.endsWith('/replies')) {
      return await handleReply(request, response, state, url);
    }
    if (url.pathname === '/api/events') return handleEvents(request, response, events);
    if (request.method === 'GET' || request.method === 'HEAD') {
      const served = await serveViewerAsset(url.pathname, response);
      if (served) return;
    }
    throw new HttpError(404, 'Architecture endpoint not found.', 'not-found');
  } catch (error) {
    sendError(response, error);
  }
}

function handleHealth(request: IncomingMessage, response: ServerResponse, state: WorkspaceState): void {
  requireMethod(request.method, 'GET');
  const loaded = state.current();
  sendJson(response, hasErrors(loaded.diagnostics) ? 503 : 200, {
    ok: !hasErrors(loaded.diagnostics),
    diagnostics: loaded.diagnostics,
  });
}

function handleModel(request: IncomingMessage, response: ServerResponse, state: WorkspaceState): void {
  requireMethod(request.method, 'GET');
  const loaded = state.current();
  sendJson(response, 200, makeViewerModel(loaded.workspace, loaded.diagnostics));
}

function handleSummary(request: IncomingMessage, response: ServerResponse, state: WorkspaceState): void {
  requireMethod(request.method, 'GET');
  const loaded = state.current();
  sendJson(response, 200, { summary: getWorkspaceSummary(loaded.workspace), diagnostics: loaded.diagnostics });
}

function handleElement(
  request: IncomingMessage,
  response: ServerResponse,
  state: WorkspaceState,
  url: URL
): void {
  requireMethod(request.method, 'GET');
  const elementId = decodeURIComponent(url.pathname.slice('/api/elements/'.length));
  const details = makeElementDetails(state.current().workspace, elementId);
  if (!details) throw new HttpError(404, `Element not found: ${elementId}`, 'element-not-found');
  sendJson(response, 200, { details });
}

async function handleSource(
  request: IncomingMessage,
  response: ServerResponse,
  state: WorkspaceState,
  options: ArchitectureServerOptions
): Promise<void> {
  requireMethod(request.method, 'POST');
  const body = await readJsonBody(request, sourcePreviewRequestSchema);
  const refs = sourceRefsForTarget(state.current().workspace, body.target);
  const sourceRef = refs?.[body.sourceIndex];
  if (!sourceRef) throw new HttpError(404, 'Source reference target was not found.', 'source-not-found');
  if (body.path !== undefined && body.path !== sourceRef.path) {
    throw new HttpError(400, 'Requested source path is not anchored on the selected target.', 'source-path-invalid');
  }
  const preview = await readSourceReference(state.current().workspace, sourceRef, {
    maxBytes: options.maxSourceBytes ?? DEFAULT_SERVER_SOURCE_BYTES,
  });
  sendJson(response, 200, { preview });
}

async function handleCreateThread(
  request: IncomingMessage,
  response: ServerResponse,
  state: WorkspaceState
): Promise<void> {
  requireMethod(request.method, 'POST');
  const body = await readJsonBody(request, createThreadRequestSchema);
  if (!state.current().workspace.indexes.elementsById.has(body.target)) {
    throw new HttpError(404, `Thread target not found: ${body.target}`, 'thread-target-not-found');
  }
  const thread = await createThread({ workspaceRoot: state.current().workspace.workspaceRoot, ...body });
  await state.reload('thread-create');
  sendJson(response, 201, { thread, artifactPath: await threadArtifactPath(state, thread.id) });
}

async function handleReply(
  request: IncomingMessage,
  response: ServerResponse,
  state: WorkspaceState,
  url: URL
): Promise<void> {
  requireMethod(request.method, 'POST');
  const threadId = decodeURIComponent(url.pathname.slice('/api/threads/'.length, -'/replies'.length));
  const body = await readJsonBody(request, replyRequestSchema);
  if (!state.current().workspace.indexes.threadsById.has(threadId)) {
    throw new HttpError(404, `Thread not found: ${threadId}`, 'thread-not-found');
  }
  const message = await appendThreadReply({ workspaceRoot: state.current().workspace.workspaceRoot, threadId, ...body });
  await state.reload('thread-reply');
  sendJson(response, 201, { message, artifactPath: await threadArtifactPath(state, threadId) });
}

function handleEvents(
  request: IncomingMessage,
  response: ServerResponse,
  events: EventHub
): void {
  requireMethod(request.method, 'GET');
  const disconnect = events.connect(response);
  request.on('close', disconnect);
}

async function threadArtifactPath(state: WorkspaceState, threadId: string): Promise<string> {
  const location = state.current().workspace.indexes.threadsById.get(threadId)?.location.file;
  if (!location) return `threads/${threadId}.thread.md`;
  return path.relative(await realpath(state.current().workspace.repoRoot), path.join(state.current().workspace.workspaceRoot, location));
}

function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function addressPort(server: Server): number {
  const address = server.address();
  if (!address || typeof address === 'string') return DEFAULT_SERVER_PORT;
  return address.port;
}
