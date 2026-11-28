/**
 * Staging-only fake AI upstream Worker, served on its own workers.dev address.
 *
 * Self-hosted Cloudflare installs price AI spend from AI Gateway logs, so a test call has to travel
 * through the real gateway to be metered. The gateway reaches this Worker as a custom provider
 * (`scripts/deploy/fake-ai-upstream.ts` creates both, staging stacks only). The Worker lives on
 * workers.dev, outside the installation's zone, so none of the zone's security rules apply and
 * none had to be loosened.
 *
 * It holds nothing worth stealing: no bindings, no secrets, no data. It never calls anything and
 * never forwards anything; every answer is a canned provider-shaped body
 * (`buildFakeUpstreamResponse`) whose usage prices to the cost the caller asks for. The gating
 * header (`ai-test-upstream-contract.ts`) is a fixed, non-secret value that the custom provider
 * config sends; it only keeps stray callers out (they get 404). A request carrying a credential header is refused, so a
 * misconfiguration can never hand a key to this Worker silently.
 */
import { readRequestJsonRecord, RequestBodyTooLargeError } from '@simple-agent-manager/worker-core';

import {
  AI_TEST_UPSTREAM_COST_HEADER,
  AI_TEST_UPSTREAM_COST_QUERY,
  AI_TEST_UPSTREAM_GATE_HEADER,
  AI_TEST_UPSTREAM_GATE_VALUE,
  AI_TEST_UPSTREAM_MAX_COST_USD,
} from './ai-test-upstream-contract';
import { buildFakeUpstreamResponse } from './ai-test-upstream-responses';

/** Largest request body the Worker reads (the canned reply ignores everything but model/stream). */
export const AI_TEST_UPSTREAM_MAX_BODY_BYTES = 1024 * 1024;
/** Headers that would carry a provider or Cloudflare credential. Their presence is refused. */
const CREDENTIAL_HEADERS = ['authorization', 'x-api-key', 'cf-aig-authorization'] as const;

function jsonError(status: number, type: string, message: string): Response {
  return new Response(JSON.stringify({ error: { type, message } }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const NOT_FOUND = (): Response => jsonError(404, 'not_found_error', 'Not found');

/** The requested cost in USD, `null` when present but invalid. Absent means 0. */
export function parseRequestedCostUsd(request: Request): number | null {
  const raw =
    request.headers.get(AI_TEST_UPSTREAM_COST_HEADER) ??
    new URL(request.url).searchParams.get(AI_TEST_UPSTREAM_COST_QUERY);
  if (raw === null || raw.trim() === '') return 0;
  const cost = Number(raw);
  if (!Number.isFinite(cost) || cost < 0 || cost > AI_TEST_UPSTREAM_MAX_COST_USD) return null;
  return cost;
}

/** Answer one request. Pure apart from reading the request; never makes a network call. */
export async function handleFakeAiUpstreamRequest(request: Request): Promise<Response> {
  if (request.method !== 'POST') return NOT_FOUND();
  if (request.headers.get(AI_TEST_UPSTREAM_GATE_HEADER) !== AI_TEST_UPSTREAM_GATE_VALUE) {
    return NOT_FOUND();
  }
  const credentialHeaders = CREDENTIAL_HEADERS.filter((name) => request.headers.has(name));
  if (credentialHeaders.length > 0) {
    // Names only, never values.
    return jsonError(
      400,
      'credential_header_rejected',
      `The SAM test upstream accepts no credentials; remove: ${credentialHeaders.join(', ')}`
    );
  }
  const costUsd = parseRequestedCostUsd(request);
  if (costUsd === null) {
    return jsonError(
      400,
      'invalid_request_error',
      `${AI_TEST_UPSTREAM_COST_HEADER} must be a number from 0 to ${AI_TEST_UPSTREAM_MAX_COST_USD}`
    );
  }
  let body: unknown;
  try {
    body = await readRequestJsonRecord(
      request,
      'ai-test-upstream-worker',
      AI_TEST_UPSTREAM_MAX_BODY_BYTES
    );
  } catch (err) {
    return err instanceof RequestBodyTooLargeError
      ? jsonError(413, 'request_too_large', 'Request body too large')
      : jsonError(400, 'invalid_request_error', 'A JSON object body is required');
  }
  return buildFakeUpstreamResponse(new URL(request.url).pathname, body, costUsd);
}

export default { fetch: handleFakeAiUpstreamRequest };
