import { realpath } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import path from 'node:path';

import {
  DEFAULT_SERVER_BODY_BYTES,
  DEFAULT_SERVER_HOST,
  DEFAULT_SERVER_PORT,
  DEFAULT_SERVER_SOURCE_BYTES,
  DEFAULT_SERVER_SSE_CLIENT_LIMIT,
  DEFAULT_SOURCE_CONTEXT_LINES,
  DEFAULT_SOURCE_PATH_LIMIT,
  DEFAULT_THREADS_DIR,
  DEFAULT_VALIDATION_ISSUE_LIMIT,
} from './constants';
import { hasErrors } from './diagnostics';
import { PathSafetyError } from './path-safety';
import { getWorkspaceSummary, type QueryLimits } from './queries';
import { EventHub } from './server/events';
import { HttpError, readJsonBody, requireMethod, sendError, sendJson } from './server/http';
import {
  DEFAULT_VIEWER_INTERACTION,
  DEFAULT_VIEWER_LIMITS,
  makeElementDetails,
  makeViewerModel,
  sourceRefsForTarget,
  type ViewerInteraction,
  type ViewerLimits,
} from './server/payloads';
import { serveViewerAsset } from './server/static-assets';
import { makeRequestSchemas } from './server/validation';
import { type WorkspaceMutationResult, WorkspaceState } from './server/workspace-state';
import { readSourceReference } from './source';
import { resolveArchitectureTarget } from './targets';
import {
  appendThreadReply,
  createThread,
  DEFAULT_THREAD_CONTENT_LIMITS,
  type ThreadContentLimits,
} from './threads';
import type { LoadWorkspaceOptions } from './types';

/** Options for the single-user local architecture viewer and HTTP API. */
export interface ArchitectureServerOptions extends LoadWorkspaceOptions {
  host?: string;
  port?: number;
  allowNonLoopback?: boolean;
  maxSourceBytes?: number;
  sourceContextLines?: number;
  maxBodyBytes?: number;
  maxSourcePathChars?: number;
  maxSseClients?: number;
  validationIssueLimit?: number;
  queryLimits?: QueryLimits;
  threadLimits?: Partial<ThreadContentLimits>;
  viewerLimits?: Partial<ViewerLimits>;
  viewerInteraction?: Partial<ViewerInteraction>;
  watchIntervalMs?: number;
}

export interface RunningArchitectureServer {
  url: string;
  server: Server;
  close: () => Promise<void>;
}

/** Start the local server after compiling a valid workspace. */
export async function startArchitectureServer(
  options: ArchitectureServerOptions = {}
): Promise<RunningArchitectureServer> {
  const host = options.host ?? DEFAULT_SERVER_HOST;
  if (!options.allowNonLoopback && !isLoopbackHost(host)) {
    throw new PathSafetyError(`Refusing non-loopback architecture server host: ${host}`);
  }
  const events = new EventHub(options.maxSseClients ?? DEFAULT_SERVER_SSE_CLIENT_LIMIT);
  const state = new WorkspaceState(options, events);
  await state.start();
  const server = createServer((request, response) => {
    void routeRequest(request, response, state, events, options, {
      host,
      port: addressPort(server),
    });
  });
  const port = options.port ?? DEFAULT_SERVER_PORT;
  try {
    await listen(server, port, host);
  } catch (error) {
    await state.stop();
    events.close();
    throw error;
  }
  return {
    url: `http://${formatAuthority(host, addressPort(server))}`,
    server,
    close: async () => {
      const closing = closeServer(server);
      events.close();
      await state.stop();
      await closing;
    },
  };
}

async function routeRequest(
  request: IncomingMessage,
  response: ServerResponse,
  state: WorkspaceState,
  events: EventHub,
  options: ArchitectureServerOptions,
  authority: { host: string; port: number }
): Promise<void> {
  try {
    const expectedAuthority = formatAuthority(authority.host, authority.port);
    validateRequestAuthority(request, expectedAuthority);
    const url = new URL(request.url ?? '/', `http://${expectedAuthority}`);
    if (url.pathname === '/health') return handleHealth(request, response, state);
    if (
      url.pathname.startsWith('/api/') &&
      url.pathname !== '/api/events' &&
      !state.hasValidModel()
    ) {
      throw new HttpError(
        503,
        'Architecture workspace is invalid; fix diagnostics before querying or mutating it.',
        'workspace-invalid'
      );
    }
    if (isMutationRoute(url.pathname) && !state.isLatestValid()) {
      throw new HttpError(
        503,
        'Architecture workspace has an invalid pending edit; fix diagnostics before mutating it.',
        'workspace-invalid'
      );
    }
    if (url.pathname === '/api/model') return handleModel(request, response, state, options);
    if (url.pathname === '/api/summary') return handleSummary(request, response, state, options);
    if (url.pathname.startsWith('/api/elements/'))
      return handleElement(request, response, state, url, options);
    if (url.pathname === '/api/source-preview')
      return await handleSource(request, response, state, options);
    if (url.pathname === '/api/threads') {
      return await handleCreateThread(request, response, state, options);
    }
    if (url.pathname.startsWith('/api/threads/') && url.pathname.endsWith('/replies')) {
      return await handleReply(request, response, state, url, options);
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

function handleHealth(
  request: IncomingMessage,
  response: ServerResponse,
  state: WorkspaceState
): void {
  requireMethod(request.method, 'GET');
  const diagnostics = state.diagnostics();
  sendJson(response, hasErrors(diagnostics) ? 503 : 200, {
    ok: !hasErrors(diagnostics),
    diagnostics,
  });
}

function handleModel(
  request: IncomingMessage,
  response: ServerResponse,
  state: WorkspaceState,
  options: ArchitectureServerOptions
): void {
  requireMethod(request.method, 'GET');
  const loaded = state.current();
  sendJson(
    response,
    200,
    makeViewerModel(
      loaded.workspace,
      state.diagnostics(),
      resolvedViewerLimits(options),
      resolvedViewerInteraction(options)
    )
  );
}

function handleSummary(
  request: IncomingMessage,
  response: ServerResponse,
  state: WorkspaceState,
  options: ArchitectureServerOptions
): void {
  requireMethod(request.method, 'GET');
  const loaded = state.current();
  sendJson(response, 200, {
    summary: getWorkspaceSummary(loaded.workspace, options.queryLimits),
    diagnostics: state.diagnostics(),
  });
}

function isMutationRoute(pathname: string): boolean {
  return (
    pathname === '/api/threads' ||
    (pathname.startsWith('/api/threads/') && pathname.endsWith('/replies'))
  );
}

function handleElement(
  request: IncomingMessage,
  response: ServerResponse,
  state: WorkspaceState,
  url: URL,
  options: ArchitectureServerOptions
): void {
  requireMethod(request.method, 'GET');
  const elementId = decodeURIComponent(url.pathname.slice('/api/elements/'.length));
  const details = makeElementDetails(
    state.current().workspace,
    elementId,
    resolvedViewerLimits(options)
  );
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
  const body = await readJsonBody(
    request,
    requestSchemas(options).sourcePreview,
    options.maxBodyBytes ?? DEFAULT_SERVER_BODY_BYTES,
    options.validationIssueLimit ?? DEFAULT_VALIDATION_ISSUE_LIMIT
  );
  const refs = sourceRefsForTarget(state.current().workspace, body.target);
  const sourceRef = refs?.[body.sourceIndex];
  if (!sourceRef)
    throw new HttpError(404, 'Source reference target was not found.', 'source-not-found');
  if (body.path !== undefined && body.path !== sourceRef.path) {
    throw new HttpError(
      400,
      'Requested source path is not anchored on the selected target.',
      'source-path-invalid'
    );
  }
  const preview = await readSourceReference(state.current().workspace, sourceRef, {
    contextLines: options.sourceContextLines ?? DEFAULT_SOURCE_CONTEXT_LINES,
    maxBytes: options.maxSourceBytes ?? DEFAULT_SERVER_SOURCE_BYTES,
  });
  sendJson(response, 200, { preview });
}

async function handleCreateThread(
  request: IncomingMessage,
  response: ServerResponse,
  state: WorkspaceState,
  options: ArchitectureServerOptions = {}
): Promise<void> {
  requireMethod(request.method, 'POST');
  const body = await readJsonBody(
    request,
    requestSchemas(options).createThread,
    options.maxBodyBytes ?? DEFAULT_SERVER_BODY_BYTES,
    options.validationIssueLimit ?? DEFAULT_VALIDATION_ISSUE_LIMIT
  );
  const result = await state.mutateLatest('thread-create', async (loaded) => {
    if (!resolveArchitectureTarget(loaded.workspace, body.target)) {
      throw new HttpError(
        404,
        `Thread target not found: ${body.target}`,
        'thread-target-not-found'
      );
    }
    return createThread({
      workspaceRoot: loaded.workspace.workspaceRoot,
      threadsDir: loaded.workspace.manifest.threadsDir,
      limits: options.threadLimits,
      ...body,
    });
  });
  const thread = requireAppliedMutation(result);
  sendJson(response, 201, { thread, artifactPath: await threadArtifactPath(state, thread.id) });
}

async function handleReply(
  request: IncomingMessage,
  response: ServerResponse,
  state: WorkspaceState,
  url: URL,
  options: ArchitectureServerOptions = {}
): Promise<void> {
  requireMethod(request.method, 'POST');
  const threadId = decodeURIComponent(
    url.pathname.slice('/api/threads/'.length, -'/replies'.length)
  );
  const body = await readJsonBody(
    request,
    requestSchemas(options).reply,
    options.maxBodyBytes ?? DEFAULT_SERVER_BODY_BYTES,
    options.validationIssueLimit ?? DEFAULT_VALIDATION_ISSUE_LIMIT
  );
  const result = await state.mutateLatest('thread-reply', async (loaded) => {
    if (!loaded.workspace.indexes.threadsById.has(threadId)) {
      throw new HttpError(404, `Thread not found: ${threadId}`, 'thread-not-found');
    }
    return appendThreadReply({
      workspaceRoot: loaded.workspace.workspaceRoot,
      threadsDir: loaded.workspace.manifest.threadsDir,
      limits: options.threadLimits,
      threadId,
      ...body,
    });
  });
  const message = requireAppliedMutation(result);
  sendJson(response, 201, { message, artifactPath: await threadArtifactPath(state, threadId) });
}

function requireAppliedMutation<T>(result: WorkspaceMutationResult<T>): T {
  if (result.status === 'invalid') {
    throw new HttpError(
      503,
      'Architecture workspace has an invalid pending edit; fix diagnostics before mutating it.',
      'workspace-invalid'
    );
  }
  if (result.status === 'persisted-invalid') {
    throw new HttpError(
      500,
      'The artifact was written but the architecture workspace failed post-write validation.',
      'workspace-post-write-invalid'
    );
  }
  return result.value;
}

function handleEvents(request: IncomingMessage, response: ServerResponse, events: EventHub): void {
  requireMethod(request.method, 'GET');
  const disconnect = events.connect(response);
  request.on('close', disconnect);
}

async function threadArtifactPath(state: WorkspaceState, threadId: string): Promise<string> {
  const location = state.current().workspace.indexes.threadsById.get(threadId)?.location.file;
  if (!location) {
    return `${state.current().workspace.manifest.threadsDir ?? DEFAULT_THREADS_DIR}/${threadId}.thread.md`;
  }
  return path.relative(
    await realpath(state.current().workspace.repoRoot),
    path.join(state.current().workspace.workspaceRoot, location)
  );
}

function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

function requestSchemas(options: ArchitectureServerOptions) {
  const threadLimits = { ...DEFAULT_THREAD_CONTENT_LIMITS, ...options.threadLimits };
  return makeRequestSchemas({
    threadAuthorChars: threadLimits.authorChars,
    threadBodyChars: threadLimits.bodyChars,
    threadTitleChars: threadLimits.titleChars,
    sourcePathChars: options.maxSourcePathChars ?? DEFAULT_SOURCE_PATH_LIMIT,
  });
}

function resolvedViewerLimits(options: ArchitectureServerOptions): ViewerLimits {
  return { ...DEFAULT_VIEWER_LIMITS, ...options.viewerLimits };
}

function resolvedViewerInteraction(options: ArchitectureServerOptions): ViewerInteraction {
  return { ...DEFAULT_VIEWER_INTERACTION, ...options.viewerInteraction };
}

function validateRequestAuthority(request: IncomingMessage, expectedAuthority: string): void {
  const requestHost = request.headers.host;
  if (requestHost !== expectedAuthority) {
    throw new HttpError(
      403,
      'Request host is not allowed by this architecture server.',
      'host-forbidden'
    );
  }
  const origin = request.headers.origin;
  if (Array.isArray(origin) || (origin !== undefined && origin !== `http://${expectedAuthority}`)) {
    throw new HttpError(
      403,
      'Cross-origin requests are not allowed by this architecture server.',
      'origin-forbidden'
    );
  }
}

function formatAuthority(host: string, port: number): string {
  const formattedHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `${formattedHost}:${port}`;
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
