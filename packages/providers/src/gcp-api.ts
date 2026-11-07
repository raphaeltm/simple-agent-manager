import { DEFAULT_GCP_MAX_LIST_PAGES } from './gcp-metadata';
import { providerDelay, providerFetch, throwIfProviderRequestAborted } from './provider-fetch';
import type { ProviderRequestContext } from './types';
import { ProviderError } from './types';
import {
  type GcpInstancePayload,
  parseProviderJson,
  validateGcpAggregatedInstances,
  validateGcpInstancesList,
  validateGcpOperation,
} from './validation';

/** What the shared GCP request helpers need from a configured `GcpProvider`. */
export interface GcpApiScope {
  readonly projectUrl: string;
  readonly timeoutMs: number;
  readonly operationPollTimeoutMs: number;
  authHeaders(context?: ProviderRequestContext): Promise<Record<string, string>>;
}

export interface GcpOperationPollLabels {
  /** Validation context recorded on a malformed operation payload. */
  readonly validationContext: string;
  /** Subject of the timeout message, e.g. "GCP operation". */
  readonly timeoutSubject: string;
}

/**
 * Poll a zonal or global operation until it completes or times out.
 * `operationUrl` is the full operations resource URL.
 */
export async function pollGcpOperation(
  scope: GcpApiScope,
  operationUrl: string,
  labels: GcpOperationPollLabels,
  context?: ProviderRequestContext
): Promise<void> {
  const deadline = Date.now() + scope.operationPollTimeoutMs;
  let delayMs = 1000;
  const maxDelayMs = 30_000;

  while (Date.now() < deadline) {
    throwIfProviderRequestAborted(context);
    const headers = await scope.authHeaders(context);
    const res = await providerFetch(
      'gcp',
      operationUrl,
      { headers },
      scope.timeoutMs,
      undefined,
      context
    );
    throwIfProviderRequestAborted(context);
    const op = validateGcpOperation(
      await parseProviderJson(res, 'gcp', labels.validationContext),
      labels.validationContext
    );
    throwIfProviderRequestAborted(context);

    if (op.status === 'DONE') {
      if (op.error?.errors?.length) {
        const errMsg = op.error.errors.map((e) => `${e.code}: ${e.message}`).join('; ');
        throw new ProviderError('gcp', undefined, `GCP operation failed: ${errMsg}`);
      }
      return;
    }

    await providerDelay(delayMs, context);
    delayMs = Math.min(delayMs * 2, maxDelayMs);
  }

  throw new ProviderError(
    'gcp',
    undefined,
    `${labels.timeoutSubject} timed out after ${scope.operationPollTimeoutMs}ms`
  );
}

type GcpInstancesPage = { items?: GcpInstancePayload[]; nextPageToken?: string };
type GcpAggregatedInstancesPage = {
  items?: Record<string, { instances?: GcpInstancePayload[] }>;
  nextPageToken?: string;
};

export async function fetchPaginatedGcpInstances(
  scope: GcpApiScope,
  baseUrl: string,
  baseParams: URLSearchParams,
  headers: Record<string, string>,
  context: string,
  handlePage: (data: GcpInstancesPage) => boolean | void,
  requestContext?: ProviderRequestContext
): Promise<void> {
  await fetchPaginatedGcpList(
    scope,
    baseUrl,
    baseParams,
    headers,
    context,
    async (payload) => {
      const data = validateGcpInstancesList(payload, context);
      const stop = handlePage(data);
      return { nextPageToken: data.nextPageToken, stop: stop === true };
    },
    requestContext
  );
}

export async function fetchPaginatedGcpAggregatedInstances(
  scope: GcpApiScope,
  baseUrl: string,
  baseParams: URLSearchParams,
  headers: Record<string, string>,
  context: string,
  handlePage: (data: GcpAggregatedInstancesPage) => boolean | void,
  requestContext?: ProviderRequestContext
): Promise<void> {
  await fetchPaginatedGcpList(
    scope,
    baseUrl,
    baseParams,
    headers,
    context,
    async (payload) => {
      const data = validateGcpAggregatedInstances(payload, context);
      const stop = handlePage(data);
      return { nextPageToken: data.nextPageToken, stop: stop === true };
    },
    requestContext
  );
}

async function fetchPaginatedGcpList(
  scope: GcpApiScope,
  baseUrl: string,
  baseParams: URLSearchParams,
  headers: Record<string, string>,
  context: string,
  handlePage: (payload: unknown) => Promise<{ nextPageToken?: string; stop?: boolean }>,
  requestContext?: ProviderRequestContext
): Promise<void> {
  const seenTokens = new Set<string>();
  let pageToken: string | undefined;

  for (let pageCount = 0; pageCount < DEFAULT_GCP_MAX_LIST_PAGES; pageCount += 1) {
    throwIfProviderRequestAborted(requestContext);
    const params = new URLSearchParams(baseParams);
    if (pageToken) params.set('pageToken', pageToken);
    const res = await providerFetch(
      'gcp',
      `${baseUrl}?${params.toString()}`,
      { headers },
      scope.timeoutMs,
      undefined,
      requestContext
    );
    throwIfProviderRequestAborted(requestContext);
    const result = await handlePage(await parseProviderJson(res, 'gcp', context));
    throwIfProviderRequestAborted(requestContext);
    if (result.stop || !result.nextPageToken) return;
    if (seenTokens.has(result.nextPageToken)) {
      throw new ProviderError(
        'gcp',
        undefined,
        `GCP ${context} pagination repeated nextPageToken`,
        {
          category: 'invalid_config',
        }
      );
    }
    seenTokens.add(result.nextPageToken);
    pageToken = result.nextPageToken;
  }

  throw new ProviderError(
    'gcp',
    undefined,
    `GCP ${context} exceeded ${DEFAULT_GCP_MAX_LIST_PAGES} pages`,
    {
      category: 'invalid_config',
    }
  );
}
