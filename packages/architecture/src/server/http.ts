import type { IncomingMessage, ServerResponse } from 'node:http';

import * as v from 'valibot';

import { DEFAULT_SERVER_BODY_BYTES, DEFAULT_VALIDATION_ISSUE_LIMIT } from '../constants';
import { PathSafetyError } from '../path-safety';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code = 'request-invalid'
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export async function readJsonBody<
  TSchema extends v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>,
>(
  request: IncomingMessage,
  schema: TSchema,
  maxBytes = DEFAULT_SERVER_BODY_BYTES
): Promise<v.InferOutput<TSchema>> {
  expectJsonContentType(request);
  const raw = await readBody(request, maxBytes);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new HttpError(400, 'Request body must be valid JSON.', 'json-invalid');
  }
  const result = v.safeParse(schema, parsed);
  if (!result.success) {
    throw new HttpError(400, summarizeIssues(result.issues), 'json-schema-invalid');
  }
  return result.output;
}

export function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    'x-content-type-options': 'nosniff',
  });
  response.end(JSON.stringify(value));
}

export function sendError(response: ServerResponse, error: unknown): void {
  const httpError = normalizeError(error);
  sendJson(response, httpError.status, {
    error: { code: httpError.code, message: httpError.message },
  });
}

export function requireMethod(actual: string | undefined, expected: string): void {
  if (actual === expected) return;
  throw new HttpError(405, `Use ${expected} for this endpoint.`, 'method-not-allowed');
}

function expectJsonContentType(request: IncomingMessage): void {
  const contentType = request.headers['content-type'] ?? '';
  if (Array.isArray(contentType) || !contentType.toLowerCase().startsWith('application/json')) {
    throw new HttpError(415, 'Use Content-Type: application/json.', 'content-type-unsupported');
  }
}

async function readBody(request: IncomingMessage, maxBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > maxBytes) {
      throw new HttpError(413, `Request body exceeds ${maxBytes} bytes.`, 'body-too-large');
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function summarizeIssues(issues: readonly v.BaseIssue<unknown>[]): string {
  const paths = issues
    .map((issue) => issue.path?.map((item) => String(item.key)).join('.'))
    .filter((path): path is string => Boolean(path));
  const visiblePaths = paths.slice(0, DEFAULT_VALIDATION_ISSUE_LIMIT);
  const suffix = paths.length > 0 ? ` Invalid fields: ${visiblePaths.join(', ')}.` : '';
  return `Request JSON does not match the expected shape.${suffix}`;
}

function normalizeError(error: unknown): HttpError {
  if (error instanceof HttpError) return error;
  if (error instanceof PathSafetyError)
    return new HttpError(400, error.message, 'path-safety-error');
  return new HttpError(
    500,
    'The architecture server failed to handle the request.',
    'server-error'
  );
}
